/**
 * MeshMule Core — Passive 915 MHz RF Link-Budget Atmospheric Tomography
 *
 * Uses active 915 MHz LoRa chirps between GPS-known peer nodes as a bistatic
 * boundary-layer atmospheric probe. By comparing theoretical Friis Free-Space
 * Path Loss (FSPL) against measured LoRa RSSI and SNR across known baseline
 * chords, this module estimates:
 *
 * 1. Excess Path Loss Residual (\Delta L_excess in dB)
 * 2. Effective Earth Radius Refractivity Factor (K-factor, standard = 1.333)
 * 3. Boundary-Layer Radio Refractivity Index (N-units)
 * 4. Over-Water Thermal Inversion / Surface Ducting vs. Foliar & Vapor Attenuation
 *
 * License: MIT (Open-Source Grant Engine / BiteWindow Vector7 Dual-Core)
 */

export interface RfTomographyPeerInput {
  nodeId: string;
  callsign: string;
  lat: number;
  lon: number;
  elevationMetersAsl: number;
  rssiDbm: number;
  snrDb: number;
  ambientTempC?: number;
  relativeHumidityPct?: number;
  stationPressureHpa?: number;
}

export interface RfChordTomographyLink {
  nodeId: string;
  callsign: string;
  distanceKm: number;
  bearingDeg: number;
  elevationDeltaMeters: number;
  rssiDbm: number;
  snrDb: number;
  theoreticalFsplDb: number;
  measuredPathLossDb: number;
  excessLossDb: number;
  estimatedKFactor: number;
  estimatedRefractivityN: number;
  fresnelFirstZoneRadiusMeters: number;
  linkRegime:
    | 'SURFACE_DUCTING_INVERSION'
    | 'NOMINAL_LINE_OF_SIGHT'
    | 'VAPOR_FOLIAR_ABSORPTION'
    | 'CANYON_KNIFE_EDGE_DIFFRACTION';
  ecologicalImplication: string;
}

export interface BasinRfTomographyReport {
  valid: boolean;
  chordCount: number;
  meanExcessLossDb: number;
  meanKFactor: number;
  meanRefractivityN: number;
  inversionDuctingDetected: boolean;
  dominantRegime:
    | 'SURFACE_DUCTING_INVERSION'
    | 'NOMINAL_LINE_OF_SIGHT'
    | 'VAPOR_FOLIAR_ABSORPTION'
    | 'CANYON_KNIFE_EDGE_DIFFRACTION';
  basinSummary: string;
  chords: RfChordTomographyLink[];
}

const DEG_TO_RAD = Math.PI / 180;
const EARTH_RADIUS_KM = 6371.0088;
const LORA_FREQ_MHZ = 915.0;
const LORA_WAVELENGTH_METERS = 299792458 / (LORA_FREQ_MHZ * 1e6); // ~0.3276 meters

/**
 * Great-circle Haversine distance (km) and forward azimuth (0-360 deg true).
 */
export function computeGreatCircleChord(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): { distanceKm: number; bearingDeg: number } {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const rLat1 = lat1 * DEG_TO_RAD;
  const rLat2 = lat2 * DEG_TO_RAD;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  const distanceKm = Math.max(0.02, EARTH_RADIUS_KM * c);

  const y = Math.sin(dLon) * Math.cos(rLat2);
  const x =
    Math.cos(rLat1) * Math.sin(rLat2) -
    Math.sin(rLat1) * Math.cos(rLat2) * Math.cos(dLon);
  const bearingDeg = ((Math.atan2(y, x) / DEG_TO_RAD) + 360) % 360;

  return {
    distanceKm: Number(distanceKm.toFixed(3)),
    bearingDeg: Number(bearingDeg.toFixed(1)),
  };
}

/**
 * Computes ITU-R P.453 Radio Refractivity N (N-units) from temperature (C),
 * pressure (hPa), and relative humidity (%):
 *   N = 77.6 * (P / T_k) + 3.73e5 * (e / T_k^2)
 */
export function computeItuRadioRefractivityN(
  pressureHpa: number = 1013.25,
  tempC: number = 15,
  relativeHumidityPct: number = 55
): number {
  const tk = tempC + 273.15;
  // Buck saturation vapor pressure equation (hPa)
  const eSat = 6.1121 * Math.exp((17.502 * tempC) / (240.97 + tempC));
  const eVapor = (Math.max(5, Math.min(100, relativeHumidityPct)) / 100) * eSat;
  const nDry = (77.6 * pressureHpa) / tk;
  const nWet = (3.73e5 * eVapor) / (tk * tk);
  return Number((nDry + nWet).toFixed(1));
}

/**
 * Analyzes 915 MHz LoRa link budget residuals across all active GPS-known peer nodes
 * to detect over-water thermal inversions, surface ducting, or moisture/canopy absorption.
 */
export function analyzeBasinRfTomography(
  originLat: number,
  originLon: number,
  originElevationMeters: number,
  peers: RfTomographyPeerInput[]
): BasinRfTomographyReport {
  const validPeers = peers.filter(
    (p) =>
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lon) &&
      (p.lat !== 0 || p.lon !== 0) &&
      Number.isFinite(p.rssiDbm)
  );

  if (validPeers.length === 0) {
    return {
      valid: false,
      chordCount: 0,
      meanExcessLossDb: 0,
      meanKFactor: 1.33,
      meanRefractivityN: 312.0,
      inversionDuctingDetected: false,
      dominantRegime: 'NOMINAL_LINE_OF_SIGHT',
      basinSummary: 'No GPS-anchored 915 MHz RF chords available for boundary-layer tomography.',
      chords: [],
    };
  }

  // Standard US 915 MHz Meshtastic system budget: +20 dBm TX + 2 dBi TX + 2 dBi RX - 2 dB feed = +22 dBm
  const systemLinkGainDbm = 22.0;

  const chords: RfChordTomographyLink[] = validPeers.map((peer) => {
    const { distanceKm, bearingDeg } = computeGreatCircleChord(
      originLat,
      originLon,
      peer.lat,
      peer.lon
    );
    const elevationDeltaMeters = Math.round(peer.elevationMetersAsl - originElevationMeters);
    const slantRangeKm = Math.hypot(distanceKm, elevationDeltaMeters / 1000);

    // Theoretical Friis Free-Space Path Loss at 915 MHz:
    // FSPL(dB) = 20*log10(d_km) + 20*log10(915) + 32.44 = 20*log10(d_km) + 91.67
    const theoreticalFsplDb = Number(
      (20 * Math.log10(Math.max(0.02, slantRangeKm)) + 91.67).toFixed(1)
    );

    // Measured path loss accounting for LoRa processing gain below thermal floor
    const snrAdjustment = peer.snrDb < 0 ? peer.snrDb * 0.35 : Math.min(3, peer.snrDb * 0.15);
    const effectiveReceivedDbm = peer.rssiDbm + snrAdjustment;
    const measuredPathLossDb = Number((systemLinkGainDbm - effectiveReceivedDbm).toFixed(1));
    const excessLossDb = Number((measuredPathLossDb - theoreticalFsplDb).toFixed(1));

    // Mid-chord 1st Fresnel zone radius: r1 = 0.5 * sqrt(lambda * d)
    const fresnelFirstZoneRadiusMeters = Number(
      (0.5 * Math.sqrt(LORA_WAVELENGTH_METERS * slantRangeKm * 1000)).toFixed(1)
    );

    // Estimate effective K-factor and Radio Refractivity N from excess path loss anomaly
    const baseN = computeItuRadioRefractivityN(
      peer.stationPressureHpa ?? 1013.25,
      peer.ambientTempC ?? 14,
      peer.relativeHumidityPct ?? 60
    );

    // Lower excess loss over multi-km chords than expected indicates super-refractive surface ducting
    // (cold river/lake surface under warm air lid bending 915 MHz rays downward)
    const expectedTerrainExcessDb = 11.5 + Math.min(18, slantRangeKm * 1.4);
    const propagationAnomalyDb = excessLossDb - expectedTerrainExcessDb;

    const estimatedKFactor = Number(
      Math.max(0.95, Math.min(2.35, 1.333 - propagationAnomalyDb * 0.028)).toFixed(2)
    );
    const estimatedRefractivityN = Number(
      Math.max(250, Math.min(410, baseN - propagationAnomalyDb * 1.65)).toFixed(1)
    );

    let linkRegime: RfChordTomographyLink['linkRegime'] = 'NOMINAL_LINE_OF_SIGHT';
    let ecologicalImplication = '';

    if (estimatedKFactor >= 1.52 || (slantRangeKm >= 1.2 && excessLossDb <= 8.5 && peer.snrDb >= 4)) {
      linkRegime = 'SURFACE_DUCTING_INVERSION';
      ecologicalImplication =
        'Super-refractive thermal inversion lid over water (K >= 1.52). Cold surface boundary layer traps midges/mayflies and concentrates twilight surface feeding.';
    } else if (Math.abs(elevationDeltaMeters) >= 350 && excessLossDb >= 26) {
      linkRegime = 'CANYON_KNIFE_EDGE_DIFFRACTION';
      ecologicalImplication =
        'High-relief granite knife-edge diffraction (+26 dB excess loss). Deep gorge acoustic/wind shadow; calm eddy dry-fly pockets protected from ridge gusts.';
    } else if (excessLossDb >= 21 || peer.snrDb <= -5.5) {
      linkRegime = 'VAPOR_FOLIAR_ABSORPTION';
      ecologicalImplication =
        'Elevated 915 MHz dielectric absorption (wet canopy / boundary-layer humidity surge). Prime low-light streamer & terrestrials window.';
    } else {
      linkRegime = 'NOMINAL_LINE_OF_SIGHT';
      ecologicalImplication =
        'Standard tropospheric refraction (K ~ 1.33). Mixed convective boundary layer; standard subsurface nymphing and afternoon riffle activity.';
    }

    return {
      nodeId: peer.nodeId,
      callsign: peer.callsign,
      distanceKm: slantRangeKm,
      bearingDeg,
      elevationDeltaMeters,
      rssiDbm: peer.rssiDbm,
      snrDb: peer.snrDb,
      theoreticalFsplDb,
      measuredPathLossDb,
      excessLossDb,
      estimatedKFactor,
      estimatedRefractivityN,
      fresnelFirstZoneRadiusMeters,
      linkRegime,
      ecologicalImplication,
    };
  });

  const meanExcessLossDb = Number(
    (chords.reduce((acc, c) => acc + c.excessLossDb, 0) / chords.length).toFixed(1)
  );
  const meanKFactor = Number(
    (chords.reduce((acc, c) => acc + c.estimatedKFactor, 0) / chords.length).toFixed(2)
  );
  const meanRefractivityN = Number(
    (chords.reduce((acc, c) => acc + c.estimatedRefractivityN, 0) / chords.length).toFixed(1)
  );

  const inversionDuctingDetected = chords.some(
    (c) => c.linkRegime === 'SURFACE_DUCTING_INVERSION'
  );

  const regimeCounts: Record<RfChordTomographyLink['linkRegime'], number> = {
    SURFACE_DUCTING_INVERSION: 0,
    NOMINAL_LINE_OF_SIGHT: 0,
    VAPOR_FOLIAR_ABSORPTION: 0,
    CANYON_KNIFE_EDGE_DIFFRACTION: 0,
  };
  for (const c of chords) {
    regimeCounts[c.linkRegime]++;
  }

  const dominantRegime = (Object.keys(regimeCounts) as Array<
    RfChordTomographyLink['linkRegime']
  >).reduce((a, b) => (regimeCounts[a] >= regimeCounts[b] ? a : b));

  let basinSummary = '';
  if (inversionDuctingDetected) {
    basinSummary = `Surface Waveguide Ducting Detected (Mean K = ${meanKFactor}, N = ${meanRefractivityN} N-units across ${chords.length} RF chords). A thermal inversion lid is trapping cool air over the water surface — prime emerger hatch & low-visibility topwater window.`;
  } else if (dominantRegime === 'VAPOR_FOLIAR_ABSORPTION') {
    basinSummary = `Boundary-Layer Moisture / Foliar Attenuation (+${meanExcessLossDb} dB mean excess path loss, K = ${meanKFactor}). High relative humidity or wet timber canopy along the river corridor.`;
  } else if (dominantRegime === 'CANYON_KNIFE_EDGE_DIFFRACTION') {
    basinSummary = `Non-Line-of-Sight Canyon Diffraction (+${meanExcessLossDb} dB mean excess loss across ${chords.length} chords). LoRa chirp spread-spectrum maintaining link across steep terrain relief.`;
  } else {
    basinSummary = `Standard Tropospheric Propagation (Mean K = ${meanKFactor}, Excess Loss = +${meanExcessLossDb} dB across ${chords.length} chords). Well-mixed diurnal boundary layer.`;
  }

  return {
    valid: true,
    chordCount: chords.length,
    meanExcessLossDb,
    meanKFactor,
    meanRefractivityN,
    inversionDuctingDetected,
    dominantRegime,
    basinSummary,
    chords,
  };
}
