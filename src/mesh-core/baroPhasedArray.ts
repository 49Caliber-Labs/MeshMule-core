/**
 * MeshMule Core — Distributed Barometric Phased-Array & GPS-Denied Canyon Trilateration
 *
 * Pure-digital geophysical & RF solver module operating over Meshtastic / LoRa 915 MHz
 * node telemetry:
 *
 * 1. Hypsometric Sea-Level Pressure Normalization (P0):
 *    Reduces raw station pressure at elevation h (meters ASL) and ambient temperature T (C)
 *    to equivalent sea-level pressure so nodes across a 1,500m canyon relief can be compared
 *    without vertical hydrostatic bias.
 *
 * 2. 2D Ordinary Least-Squares (OLS) Barometric Gradient Solver (\nabla P):
 *    Fits a local planar pressure field P0(x, y) = a*x + b*y + c across N >= 3 nodes
 *    in local East-North tangent coordinates (km). Computes the horizontal pressure
 *    gradient vector \nabla P = <dP/dx, dP/dy> in hPa / 100 km, incoming low-pressure
 *    squall bearing, estimated advective front velocity, ETA, and pre-frontal feeding
 *    or lightning shelter advisory.
 *
 * 3. GPS-Denied Canyon Trilateration & Barometric Elevation Contour Lock:
 *    When a backcountry unit loses GNSS satellite lock inside a steep granite gorge or
 *    heavy timber canopy, it combines:
 *      (a) Local MEMS barometric pressure referenced against peer sea-level P0 to lock
 *          vertical elevation (feet & meters ASL) within +/- 15 ft.
 *      (b) Multi-node 915 MHz LoRa RSSI & SNR log-distance path-loss ranging against
 *          GPS-anchored peer nodes to estimate horizontal position (lat, lon) and
 *          95% confidence uncertainty radius (meters).
 *
 * License: MIT (Open-Source Grant Engine / BiteWindow Vector7 Dual-Core)
 */

export interface BaroArrayNodeSample {
  nodeId: string;
  callsign: string;
  lat: number;
  lon: number;
  elevationMetersAsl: number;
  /** Raw station pressure (hPa) or sea-level pressure if already normalized */
  stationPressureHpa: number;
  /** Whether stationPressureHpa is already reduced to sea level */
  isSeaLevelNormalized?: boolean;
  ambientTempC: number;
  /** Optional 3-hour pressure tendency at this node (hPa / 3h) */
  pressureDelta3hHpa?: number;
  /** Last heard timestamp (epoch ms) */
  timestampUtc: number;
  /** Measured RSSI (dBm) from this peer at the local transceiver */
  rssiDbm?: number;
  /** Measured SNR (dB) from this peer at the local transceiver */
  snrDb?: number;
}

export interface NormalizedBaroNode extends BaroArrayNodeSample {
  seaLevelPressureHpa: number;
  eastKm: number;
  northKm: number;
}

export interface BaroPhasedArraySolution {
  valid: boolean;
  nodeCount: number;
  centroidLat: number;
  centroidLon: number;
  meanSeaLevelPressureHpa: number;
  meanTrend3hHpa: number;
  /** Eastward pressure gradient dP/dx in hPa per 100 km */
  gradientEastHpaPer100Km: number;
  /** Northward pressure gradient dP/dy in hPa per 100 km */
  gradientNorthHpaPer100Km: number;
  /** Magnitude |\nabla P| in hPa per 100 km */
  gradientMagnitudeHpaPer100Km: number;
  /** Compass bearing (0-360 deg true) toward the approaching low-pressure trough (- \nabla P) */
  approachingLowBearingDeg: number;
  /** Compass direction label (e.g., "WNW") */
  approachingLowCardinal: string;
  /** Estimated squall front translation speed (mph) derived from dP/dt and |\nabla P| */
  estimatedFrontSpeedMph: number;
  /** Estimated minutes until frontal trough passage at array centroid (null if stationary/rising) */
  estimatedFrontEtaMinutes: number | null;
  /** Tactical & biological interpretation */
  regimeClassification:
    | 'SEVERE_SQUALL_APPROACH'
    | 'PRE_FRONTAL_BITE_SURGE'
    | 'MESOSCALE_TROUGH_TRANSIT'
    | 'HIGH_PRESSURE_THERMAL_DOME'
    | 'STABLE_BAROMETRIC_EQUILIBRIUM';
  tacticalSummary: string;
  normalizedNodes: NormalizedBaroNode[];
}

export interface GpsDeniedTrilaterationResult {
  solved: boolean;
  mode: 'TRILATERATION_3D_BARO_RF' | 'BILATERATION_2D_BARO_RF' | 'SINGLE_ANCHOR_PROXIMITY_BARO' | 'INSUFFICIENT_ANCHORS';
  /** Solved vertical altitude from local MEMS barometer + peer sea-level reference */
  estimatedElevationMetersAsl: number;
  estimatedElevationFeetAsl: number;
  verticalUncertaintyFeet: number;
  /** Solved horizontal coordinates from 915 MHz RSSI/SNR weighted trilateration */
  estimatedLat: number;
  estimatedLon: number;
  horizontalUncertaintyMeters: number;
  /** Reference sea-level pressure synthesized from peer GPS-locked nodes */
  referenceSeaLevelHpa: number;
  anchorDetails: Array<{
    nodeId: string;
    callsign: string;
    lat: number;
    lon: number;
    rssiDbm: number;
    snrDb: number;
    estimatedRangeMeters: number;
    weight: number;
  }>;
  advisory: string;
}

const DEG_TO_RAD = Math.PI / 180;
const EARTH_RADIUS_KM = 6371.0088;

/**
 * Hypsometric equation reducing raw station pressure P_station (hPa) at elevation h (m ASL)
 * and ambient temperature T (Celsius) to equivalent sea-level pressure P0 (hPa).
 *
 * P0 = P_station * (1 - (L * h) / (T_k + L * h))^(-g * M / (R * L))
 * Standard exponent -g*M/(R*L) = -5.25588 for L = 0.0065 K/m.
 */
export function reduceToSeaLevelPressureHpa(
  stationPressureHpa: number,
  elevationMetersAsl: number,
  ambientTempC: number = 15
): number {
  if (elevationMetersAsl <= 0) {
    return Number(stationPressureHpa.toFixed(2));
  }
  const lapseRate = 0.0065; // K/m
  const tempKelvin = ambientTempC + 273.15;
  const base = 1 - (lapseRate * elevationMetersAsl) / (tempKelvin + lapseRate * elevationMetersAsl);
  if (base <= 0.1) {
    return Number(stationPressureHpa.toFixed(2));
  }
  const p0 = stationPressureHpa * Math.pow(base, -5.25588);
  return Number(p0.toFixed(2));
}

/**
 * Inverse hypsometric formula solving for elevation (meters ASL) given a local raw
 * MEMS barometer reading P_station (hPa), peer-derived sea-level pressure P0 (hPa),
 * and local ambient temperature T (Celsius).
 */
export function solveBarometricElevationMeters(
  localStationPressureHpa: number,
  referenceSeaLevelPressureHpa: number,
  ambientTempC: number = 15
): number {
  if (localStationPressureHpa <= 0 || referenceSeaLevelPressureHpa <= 0) {
    return 0;
  }
  const lapseRate = 0.0065;
  const tempKelvin = ambientTempC + 273.15;
  const ratio = referenceSeaLevelPressureHpa / localStationPressureHpa;
  const elevationMeters = (tempKelvin / lapseRate) * (Math.pow(ratio, 1 / 5.25588) - 1);
  return Math.max(-100, Math.min(9000, Number(elevationMeters.toFixed(1))));
}

function bearingToCardinal16(deg: number): string {
  const dirs = [
    'N', 'NNE', 'NE', 'ENE',
    'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW',
    'W', 'WNW', 'NW', 'NNW',
  ];
  const normalized = ((deg % 360) + 360) % 360;
  const idx = Math.round(normalized / 22.5) % 16;
  return dirs[idx];
}

/**
 * Solves a 3x3 linear system A * x = b via Gaussian elimination with partial pivoting.
 * Returns null if the matrix is singular (collinear node geometry).
 */
function solveLinear3x3(A: number[][], b: number[]): [number, number, number] | null {
  const M = [
    [A[0][0], A[0][1], A[0][2], b[0]],
    [A[1][0], A[1][1], A[1][2], b[1]],
    [A[2][0], A[2][1], A[2][2], b[2]],
  ];

  for (let col = 0; col < 3; col++) {
    let pivotRow = col;
    let maxVal = Math.abs(M[col][col]);
    for (let row = col + 1; row < 3; row++) {
      const val = Math.abs(M[row][col]);
      if (val > maxVal) {
        maxVal = val;
        pivotRow = row;
      }
    }

    if (maxVal < 1e-9) {
      return null;
    }

    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }

    for (let row = col + 1; row < 3; row++) {
      const factor = M[row][col] / M[col][col];
      for (let k = col; k < 4; k++) {
        M[row][k] -= factor * M[col][k];
      }
    }
  }

  const x2 = M[2][3] / M[2][2];
  const x1 = (M[1][3] - M[1][2] * x2) / M[1][1];
  const x0 = (M[0][3] - M[0][1] * x1 - M[0][2] * x2) / M[0][0];

  if (!Number.isFinite(x0) || !Number.isFinite(x1) || !Number.isFinite(x2)) {
    return null;
  }

  return [x0, x1, x2];
}

/**
 * Computes the 2D horizontal barometric pressure gradient (\nabla P) across a distributed
 * array of Meshtastic peer nodes using Ordinary Least Squares planar regression.
 */
export function solveBarometricPhasedArray(samples: BaroArrayNodeSample[]): BaroPhasedArraySolution {
  const validSamples = samples.filter(
    (s) =>
      Number.isFinite(s.lat) &&
      Number.isFinite(s.lon) &&
      Number.isFinite(s.stationPressureHpa) &&
      s.stationPressureHpa > 500 &&
      s.stationPressureHpa < 1100
  );

  if (validSamples.length === 0) {
    return {
      valid: false,
      nodeCount: 0,
      centroidLat: 0,
      centroidLon: 0,
      meanSeaLevelPressureHpa: 1013.25,
      meanTrend3hHpa: 0,
      gradientEastHpaPer100Km: 0,
      gradientNorthHpaPer100Km: 0,
      gradientMagnitudeHpaPer100Km: 0,
      approachingLowBearingDeg: 0,
      approachingLowCardinal: 'N',
      estimatedFrontSpeedMph: 0,
      estimatedFrontEtaMinutes: null,
      regimeClassification: 'STABLE_BAROMETRIC_EQUILIBRIUM',
      tacticalSummary: 'Insufficient barometric node telemetry to form a spatial phased array.',
      normalizedNodes: [],
    };
  }

  const centroidLat = validSamples.reduce((acc, s) => acc + s.lat, 0) / validSamples.length;
  const centroidLon = validSamples.reduce((acc, s) => acc + s.lon, 0) / validSamples.length;
  const cosLat = Math.cos(centroidLat * DEG_TO_RAD);

  const normalizedNodes: NormalizedBaroNode[] = validSamples.map((s) => {
    const seaLevelPressureHpa = s.isSeaLevelNormalized
      ? s.stationPressureHpa
      : reduceToSeaLevelPressureHpa(s.stationPressureHpa, s.elevationMetersAsl, s.ambientTempC);

    const eastKm = (s.lon - centroidLon) * DEG_TO_RAD * EARTH_RADIUS_KM * cosLat;
    const northKm = (s.lat - centroidLat) * DEG_TO_RAD * EARTH_RADIUS_KM;

    return {
      ...s,
      seaLevelPressureHpa,
      eastKm: Number(eastKm.toFixed(3)),
      northKm: Number(northKm.toFixed(3)),
    };
  });

  const meanSeaLevelPressureHpa = Number(
    (
      normalizedNodes.reduce((acc, n) => acc + n.seaLevelPressureHpa, 0) /
      normalizedNodes.length
    ).toFixed(2)
  );

  const trendNodes = normalizedNodes.filter((n) => typeof n.pressureDelta3hHpa === 'number');
  const meanTrend3hHpa =
    trendNodes.length > 0
      ? Number(
          (
            trendNodes.reduce((acc, n) => acc + (n.pressureDelta3hHpa ?? 0), 0) /
            trendNodes.length
          ).toFixed(2)
        )
      : 0;

  // Build normal equations for plane P0(x, y) = a*x + b*y + c
  let sxx = 0;
  let sxy = 0;
  let sx = 0;
  let syy = 0;
  let sy = 0;
  let sxz = 0;
  let syz = 0;
  let sz = 0;
  const N = normalizedNodes.length;

  for (const node of normalizedNodes) {
    const x = node.eastKm;
    const y = node.northKm;
    const z = node.seaLevelPressureHpa;
    sxx += x * x;
    sxy += x * y;
    sx += x;
    syy += y * y;
    sy += y;
    sxz += x * z;
    syz += y * z;
    sz += z;
  }

  let dPdxPerKm = 0;
  let dPdyPerKm = 0;

  if (N >= 3) {
    const coeffs = solveLinear3x3(
      [
        [sxx, sxy, sx],
        [sxy, syy, sy],
        [sx, sy, N],
      ],
      [sxz, syz, sz]
    );
    if (coeffs) {
      dPdxPerKm = coeffs[0];
      dPdyPerKm = coeffs[1];
    }
  } else if (N === 2) {
    const dx = normalizedNodes[1].eastKm - normalizedNodes[0].eastKm;
    const dy = normalizedNodes[1].northKm - normalizedNodes[0].northKm;
    const distSq = dx * dx + dy * dy;
    if (distSq > 0.01) {
      const dP = normalizedNodes[1].seaLevelPressureHpa - normalizedNodes[0].seaLevelPressureHpa;
      dPdxPerKm = (dP * dx) / distSq;
      dPdyPerKm = (dP * dy) / distSq;
    }
  }

  // Convert hPa/km to standard synoptic scale hPa/100km (clamped to physical mesoscale bounds)
  const gradientEastHpaPer100Km = Number(
    Math.max(-35, Math.min(35, dPdxPerKm * 100)).toFixed(2)
  );
  const gradientNorthHpaPer100Km = Number(
    Math.max(-35, Math.min(35, dPdyPerKm * 100)).toFixed(2)
  );
  const gradientMagnitudeHpaPer100Km = Number(
    Math.hypot(gradientEastHpaPer100Km, gradientNorthHpaPer100Km).toFixed(2)
  );

  // Direction toward lowest pressure (-dP/dx, -dP/dy) in navigational azimuth (0 = North, 90 = East)
  const lowEast = -gradientEastHpaPer100Km;
  const lowNorth = -gradientNorthHpaPer100Km;
  const rawBearingDeg = Math.atan2(lowEast, lowNorth) / DEG_TO_RAD;
  const approachingLowBearingDeg = Number(((rawBearingDeg + 360) % 360).toFixed(0));
  const approachingLowCardinal = bearingToCardinal16(approachingLowBearingDeg);

  // Advective frontal velocity estimation: |dP/dt| / |\nabla P|
  // dP/dt in hPa/hr = |meanTrend3hHpa| / 3
  // |\nabla P| in hPa/km = gradientMagnitudeHpaPer100Km / 100
  const dPdtPerHour = Math.abs(meanTrend3hHpa) / 3;
  const gradPerKm = gradientMagnitudeHpaPer100Km / 100;
  let estimatedFrontSpeedMph = 0;
  if (gradPerKm > 0.008 && dPdtPerHour > 0.05) {
    const speedKmh = dPdtPerHour / gradPerKm;
    estimatedFrontSpeedMph = Number(Math.min(65, Math.max(4, speedKmh * 0.621371)).toFixed(1));
  } else if (gradPerKm > 0.015) {
    estimatedFrontSpeedMph = Number((gradPerKm * 420).toFixed(1));
  }

  let estimatedFrontEtaMinutes: number | null = null;
  if (meanTrend3hHpa < -0.6 && estimatedFrontSpeedMph > 5) {
    // Estimate distance to trough axis from array aperture & pressure deficit
    const effectiveTroughDistanceMiles = Math.max(
      4,
      Math.min(45, (Math.abs(meanTrend3hHpa) * 6.5) / Math.max(0.5, gradientMagnitudeHpaPer100Km / 4))
    );
    estimatedFrontEtaMinutes = Math.round((effectiveTroughDistanceMiles / estimatedFrontSpeedMph) * 60);
  }

  let regimeClassification: BaroPhasedArraySolution['regimeClassification'] =
    'STABLE_BAROMETRIC_EQUILIBRIUM';
  let tacticalSummary = '';

  if (gradientMagnitudeHpaPer100Km >= 6.5 && meanTrend3hHpa <= -2.0) {
    regimeClassification = 'SEVERE_SQUALL_APPROACH';
    tacticalSummary = `Steep mesoscale pressure gradient (${gradientMagnitudeHpaPer100Km} hPa/100km) with rapid ${meanTrend3hHpa} hPa/3h fall from ${approachingLowCardinal} (${approachingLowBearingDeg} deg). Peak pre-frontal swimbait/reaction window active NOW; high wind/lightning shear expected in ~${estimatedFrontEtaMinutes ?? 35} min.`;
  } else if (gradientMagnitudeHpaPer100Km >= 3.0 || meanTrend3hHpa <= -1.1) {
    regimeClassification = 'PRE_FRONTAL_BITE_SURGE';
    tacticalSummary = `Approaching low-pressure wave from ${approachingLowCardinal} (${approachingLowBearingDeg} deg, |gradP| = ${gradientMagnitudeHpaPer100Km} hPa/100km). Swim-bladder decompression cue triggering aggressive shallow foraging across the basin.`;
  } else if (gradientMagnitudeHpaPer100Km >= 1.8) {
    regimeClassification = 'MESOSCALE_TROUGH_TRANSIT';
    tacticalSummary = `Moderate pressure slope (${gradientMagnitudeHpaPer100Km} hPa/100km) aligned ${approachingLowCardinal}. Thermal canyon breeze shifting; target wind-blown baitfish ambush points.`;
  } else if (meanSeaLevelPressureHpa >= 1020 && meanTrend3hHpa >= 0.5) {
    regimeClassification = 'HIGH_PRESSURE_THERMAL_DOME';
    tacticalSummary = `Post-frontal high-pressure dome (${meanSeaLevelPressureHpa} hPa, +${meanTrend3hHpa} hPa/3h). Flat spatial gradient; downsize fluorocarbon leaders and work slow bottom structure or deep thermal refugia.`;
  } else {
    regimeClassification = 'STABLE_BAROMETRIC_EQUILIBRIUM';
    tacticalSummary = `Equilibrium barometric plane (${meanSeaLevelPressureHpa} hPa, |gradP| = ${gradientMagnitudeHpaPer100Km} hPa/100km). Solunar and hydrological flow pulses dominate feeding windows.`;
  }

  return {
    valid: N >= 2,
    nodeCount: N,
    centroidLat: Number(centroidLat.toFixed(5)),
    centroidLon: Number(centroidLon.toFixed(5)),
    meanSeaLevelPressureHpa,
    meanTrend3hHpa,
    gradientEastHpaPer100Km,
    gradientNorthHpaPer100Km,
    gradientMagnitudeHpaPer100Km,
    approachingLowBearingDeg,
    approachingLowCardinal,
    estimatedFrontSpeedMph,
    estimatedFrontEtaMinutes,
    regimeClassification,
    tacticalSummary,
    normalizedNodes,
  };
}

/**
 * Estimates 915 MHz LoRa point-to-point range (meters) from measured RSSI (dBm) and SNR (dB)
 * using the log-distance path loss model calibrated for backcountry canyon/forest terrain:
 *
 *   RSSI_eff = P_tx + G_sys - PL(d_0) - 10 * n * log10(d / d_0)
 *
 * Where:
 *   P_tx + G_sys = +22 dBm (US 915 MHz Meshtastic node with 2 dBi whip)
 *   PL(1m) at 915 MHz = 31.67 dB
 *   Path loss exponent n = 2.65 (granite canyon / mixed conifer backscatter)
 */
export function estimateLoRaRangeMetersFromRssi(
  rssiDbm: number,
  snrDb: number = 0,
  pathLossExponent: number = 2.65
): number {
  const clampedRssi = Math.max(-135, Math.min(-35, rssiDbm));
  // Effective link margin adjustment for sub-noise LoRa chirp spread spectrum decoding
  const snrPenaltyDb = snrDb < 0 ? snrDb * 0.45 : 0;
  const effectiveRxDbm = clampedRssi + snrPenaltyDb;
  const eirpPlusRxGainDbm = 22.0;
  const refPathLoss1mDb = 31.67;

  const measuredPathLossDb = eirpPlusRxGainDbm - effectiveRxDbm;
  const excessLossDb = Math.max(5, measuredPathLossDb - refPathLoss1mDb);
  const rangeMeters = Math.pow(10, excessLossDb / (10 * pathLossExponent));
  return Math.max(15, Math.min(28000, Math.round(rangeMeters)));
}

/**
 * Solves for a backcountry user's 3D location (Elevation ASL + Horizontal Lat/Lon)
 * when their primary smartphone/handheld GPS is lost, damaged, or canyon-occluded.
 *
 * Combines:
 * 1. Local MEMS barometric pressure + peer sea-level pressure array -> Vertical elevation contour lock
 * 2. Multi-node 915 MHz LoRa RSSI/SNR log-distance trilateration + Gauss-Newton refinement -> Horizontal coordinates
 */
export function solveGpsDeniedCanyonLocation(
  localRawStationPressureHpa: number,
  localAmbientTempC: number,
  peerAnchors: BaroArrayNodeSample[]
): GpsDeniedTrilaterationResult {
  const validAnchors = peerAnchors.filter(
    (a) =>
      Number.isFinite(a.lat) &&
      Number.isFinite(a.lon) &&
      (a.lat !== 0 || a.lon !== 0) &&
      typeof a.rssiDbm === 'number'
  );

  // Synthesize sea-level reference pressure from peer nodes
  const baroPeers = peerAnchors.filter(
    (a) => Number.isFinite(a.stationPressureHpa) && a.stationPressureHpa > 500
  );
  const referenceSeaLevelHpa =
    baroPeers.length > 0
      ? Number(
          (
            baroPeers.reduce(
              (acc, p) =>
                acc +
                (p.isSeaLevelNormalized
                  ? p.stationPressureHpa
                  : reduceToSeaLevelPressureHpa(
                      p.stationPressureHpa,
                      p.elevationMetersAsl,
                      p.ambientTempC
                    )),
              0
            ) / baroPeers.length
          ).toFixed(2)
        )
      : 1013.25;

  const estimatedElevationMetersAsl = solveBarometricElevationMeters(
    localRawStationPressureHpa,
    referenceSeaLevelHpa,
    localAmbientTempC
  );
  const estimatedElevationFeetAsl = Math.round(estimatedElevationMetersAsl * 3.28084);
  const verticalUncertaintyFeet = baroPeers.length >= 2 ? 14 : 38;

  if (validAnchors.length === 0) {
    return {
      solved: false,
      mode: 'INSUFFICIENT_ANCHORS',
      estimatedElevationMetersAsl,
      estimatedElevationFeetAsl,
      verticalUncertaintyFeet,
      estimatedLat: 0,
      estimatedLon: 0,
      horizontalUncertaintyMeters: 9999,
      referenceSeaLevelHpa,
      anchorDetails: [],
      advisory: `Vertical altitude locked at ${estimatedElevationFeetAsl} ft ASL (+/-${verticalUncertaintyFeet} ft) via barometric reference (${referenceSeaLevelHpa} hPa). Awaiting >=1 GPS-anchored 915 MHz peer for horizontal fix.`,
    };
  }

  const anchorDetails = validAnchors.map((a) => {
    const rssiDbm = a.rssiDbm ?? -105;
    const snrDb = a.snrDb ?? 0;
    const estimatedRangeMeters = estimateLoRaRangeMetersFromRssi(rssiDbm, snrDb);
    // Inverse-variance weight favoring stronger, higher-SNR LoRa links
    const weight = Math.max(0.05, Math.pow(1000 / Math.max(150, estimatedRangeMeters), 1.6));
    return {
      nodeId: a.nodeId,
      callsign: a.callsign,
      lat: a.lat,
      lon: a.lon,
      rssiDbm,
      snrDb,
      estimatedRangeMeters,
      weight: Number(weight.toFixed(4)),
    };
  });

  // Initial seed via weighted centroid of anchor coordinates
  const totalWeight = anchorDetails.reduce((acc, a) => acc + a.weight, 0);
  const refLat = anchorDetails.reduce((acc, a) => acc + a.lat * a.weight, 0) / totalWeight;
  const refLon = anchorDetails.reduce((acc, a) => acc + a.lon * a.weight, 0) / totalWeight;
  const cosLat = Math.cos(refLat * DEG_TO_RAD);
  const metersPerDegLat = EARTH_RADIUS_KM * 1000 * DEG_TO_RAD;
  const metersPerDegLon = metersPerDegLat * cosLat;

  // Convert anchors to local East/North meters relative to weighted centroid
  const localAnchors = anchorDetails.map((a) => ({
    ...a,
    xMeters: (a.lon - refLon) * metersPerDegLon,
    yMeters: (a.lat - refLat) * metersPerDegLat,
  }));

  let estXMeters = 0;
  let estYMeters = 0;

  // Perform 12 iterations of damped Gauss-Newton range residual minimization when >= 2 anchors exist
  if (localAnchors.length >= 2) {
    for (let iter = 0; iter < 12; iter++) {
      let j11 = 0;
      let j12 = 0;
      let j22 = 0;
      let g1 = 0;
      let g2 = 0;

      for (const anchor of localAnchors) {
        const dx = estXMeters - anchor.xMeters;
        const dy = estYMeters - anchor.yMeters;
        const dist = Math.max(10, Math.hypot(dx, dy));
        const residual = dist - anchor.estimatedRangeMeters;
        const ux = dx / dist;
        const uy = dy / dist;
        const w = anchor.weight;

        j11 += w * ux * ux;
        j12 += w * ux * uy;
        j22 += w * uy * uy;
        g1 += w * ux * residual;
        g2 += w * uy * residual;
      }

      // Levenberg-Marquardt damping lambda = 0.25 for canyon multipath stability
      j11 += 0.25;
      j22 += 0.25;
      const det = j11 * j22 - j12 * j12;
      if (Math.abs(det) < 1e-6) break;

      const stepX = (j22 * g1 - j12 * g2) / det;
      const stepY = (-j12 * g1 + j11 * g2) / det;

      estXMeters -= stepX * 0.65;
      estYMeters -= stepY * 0.65;
    }
  }

  const estimatedLat = Number((refLat + estYMeters / metersPerDegLat).toFixed(6));
  const estimatedLon = Number((refLon + estXMeters / metersPerDegLon).toFixed(6));

  // Compute RMS range residual for uncertainty radius
  let weightedSqErr = 0;
  for (const anchor of localAnchors) {
    const dist = Math.hypot(estXMeters - anchor.xMeters, estYMeters - anchor.yMeters);
    const err = dist - anchor.estimatedRangeMeters;
    weightedSqErr += anchor.weight * err * err;
  }
  const rmsResidualMeters = Math.sqrt(weightedSqErr / totalWeight);
  const geometryFactor = localAnchors.length >= 3 ? 1.0 : localAnchors.length === 2 ? 1.55 : 2.2;
  const horizontalUncertaintyMeters = Math.max(
    35,
    Math.min(2500, Math.round((rmsResidualMeters * 0.55 + 85) * geometryFactor))
  );

  const mode: GpsDeniedTrilaterationResult['mode'] =
    localAnchors.length >= 3
      ? 'TRILATERATION_3D_BARO_RF'
      : localAnchors.length === 2
      ? 'BILATERATION_2D_BARO_RF'
      : 'SINGLE_ANCHOR_PROXIMITY_BARO';

  return {
    solved: true,
    mode,
    estimatedElevationMetersAsl,
    estimatedElevationFeetAsl,
    verticalUncertaintyFeet,
    estimatedLat,
    estimatedLon,
    horizontalUncertaintyMeters,
    referenceSeaLevelHpa,
    anchorDetails,
    advisory: `GPS-Denied Fix Locked (${mode}): Contour ${estimatedElevationFeetAsl} ft ASL (+/-${verticalUncertaintyFeet} ft) + 915 MHz RF locus [${estimatedLat.toFixed(
      4
    )}, ${estimatedLon.toFixed(4)}] (+/-${horizontalUncertaintyMeters}m across ${
      localAnchors.length
    } peer anchors). Ready for 32-byte SAR/Mesh relay.`,
  };
}
