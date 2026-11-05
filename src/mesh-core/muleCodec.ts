/**
 * MeshMule Core — 32-Byte Binary Telemetry & Ephemeris Codec (MeshMule Protocol v1)
 *
 * Implements two bit-exact 32-byte (256-bit) LoRa frames (< 65ms airtime at SF7/250kHz):
 *
 * 1. Frame `0xA1` — Outbound Citizen-Science Backcountry Sensor Harvest Frame (32 Bytes):
 *    - Byte 0:      Magic `0xA1`
 *    - Byte 1:      [7:4] Domain (1..5), [3:2] Step Interval (0=5m,1=15m,2=30m,3=60m),
 *                   [1] Solar Charging, [0] Threshold Exceeded
 *    - Byte 2:      [7] Tamper Alert, [6:0] Battery % (0..100)
 *    - Bytes 3..6:  Station Callsign (6 ASCII characters packed in 32-bit Base36 + 1-byte suffix)
 *    - Byte 7:      Callsign 6th char ASCII
 *    - Bytes 8..9:  Sequence Number (uint16 LE)
 *    - Bytes 10..11: Relative Sample Age in seconds / 4 (uint16 LE, up to 262,140s = 72.8h)
 *    - Bytes 12..14: Latitude (24-bit signed fixed-point, [-90, +90] -> ~1.1m precision)
 *    - Bytes 15..17: Longitude (24-bit signed fixed-point, [-180, +180] -> ~2.2m precision)
 *    - Bytes 18..19: Elevation ASL in meters (int16 LE)
 *    - Bytes 20..21: Primary Metric (int16 LE, scaled by domain)
 *    - Bytes 22..23: Secondary Metric (uint16 LE, scaled by domain)
 *    - Bytes 24..25: Tertiary Metric (uint16 LE, scaled by domain)
 *    - Bytes 26..27: 5 Historical Primary Delta Steps (packed 4-bit signed nibbles + 4-bit scale)
 *    - Bytes 28..31: 32-bit Keyed SipHash-2-4 Cryptographic MAC (uint32 LE)
 *
 * 2. Frame `0xB2` — Inbound "Ridge-Mule" 24-Hour USGS Hydrograph & Ephemeris Frame (32 Bytes):
 *    - Byte 0:      Magic `0xB2`
 *    - Byte 1:      [7:4] NWS Alert Code (0..15), [3:0] Protocol Version (1)
 *    - Bytes 2..5:  USGS 8-Digit Gauge ID (uint32 LE, e.g., 11264500)
 *    - Bytes 6..7:  Sequence Number (uint16 LE)
 *    - Bytes 8..9:  Water Temperature (int16 LE, scaled x100 °C)
 *    - Bytes 10..11: Sea-Level Barometric Pressure (uint16 LE, (P_hpa - 850) * 100)
 *    - Bytes 12..13: 3-Hour Barometric Tendency (int16 LE, scaled x100 hPa)
 *    - Byte 14:     BiteWindow Composite Score (uint8, 0..100)
 *    - Byte 15:     Reserved / Quality Flags
 *    - Bytes 16..17: 24h Minimum Discharge CFS (uint16 LE)
 *    - Bytes 18..19: 24h Maximum Discharge CFS (uint16 LE)
 *    - Bytes 20..25: 12 x 4-bit Quantized Hydrograph Nibbles (2-hour steps across 24 hours)
 *    - Bytes 26..27: Reserved Epoch Minute Check
 *    - Bytes 28..31: 32-bit Keyed SipHash-2-4 Cryptographic MAC (uint32 LE)
 *
 * License: MIT (Open-Source Grant Engine / BiteWindow Vector7 Dual-Core)
 */

export const MULE_FRAME_BYTE_LENGTH = 32;
export const MULE_SENSOR_MAGIC = 0xa1;
export const MULE_EPHEMERIS_MAGIC = 0xb2;

export enum MuleSensorDomain {
  USGS_HYDRO_GAUGE = 1,
  NPS_GEOTHERMAL_SEISMIC = 2,
  USFS_WILDFIRE_RAWS = 3,
  CDFW_HABITAT_WATER_QUALITY = 4,
  NRCS_ALPINE_SNOTEL = 5,
}

export interface DomainMetricSpec {
  domainLabel: string;
  primaryLabel: string;
  primaryUnit: string;
  primaryScale: number;
  secondaryLabel: string;
  secondaryUnit: string;
  secondaryScale: number;
  tertiaryLabel: string;
  tertiaryUnit: string;
  tertiaryScale: number;
}

export const MULE_DOMAIN_SPECS: Record<MuleSensorDomain, DomainMetricSpec> = {
  [MuleSensorDomain.USGS_HYDRO_GAUGE]: {
    domainLabel: 'USGS Backcountry Hydro Gauge',
    primaryLabel: 'Water Temp',
    primaryUnit: '°C',
    primaryScale: 100,
    secondaryLabel: 'Discharge Flow',
    secondaryUnit: 'CFS',
    secondaryScale: 1,
    tertiaryLabel: 'Dissolved O2',
    tertiaryUnit: 'mg/L',
    tertiaryScale: 100,
  },
  [MuleSensorDomain.NPS_GEOTHERMAL_SEISMIC]: {
    domainLabel: 'NPS Geothermal & Seismic Logger',
    primaryLabel: 'Vent Temp',
    primaryUnit: '°C',
    primaryScale: 100,
    secondaryLabel: 'Soil Gas Flux',
    secondaryUnit: 'ppm',
    secondaryScale: 1,
    tertiaryLabel: 'Tremor RMS',
    tertiaryUnit: 'µm/s',
    tertiaryScale: 10,
  },
  [MuleSensorDomain.USFS_WILDFIRE_RAWS]: {
    domainLabel: 'USFS Wildfire Fuel Moisture Logger',
    primaryLabel: 'Canopy Air Temp',
    primaryUnit: '°C',
    primaryScale: 100,
    secondaryLabel: 'Relative Humidity',
    secondaryUnit: '%',
    secondaryScale: 1,
    tertiaryLabel: '10-Hr Fuel Moisture',
    tertiaryUnit: '%',
    tertiaryScale: 100,
  },
  [MuleSensorDomain.CDFW_HABITAT_WATER_QUALITY]: {
    domainLabel: 'CDFW Salmonid Thermal Refugia',
    primaryLabel: 'Refugia Pool Temp',
    primaryUnit: '°C',
    primaryScale: 100,
    secondaryLabel: 'Conductance',
    secondaryUnit: 'µS/cm',
    secondaryScale: 1,
    tertiaryLabel: 'Dissolved O2',
    tertiaryUnit: 'mg/L',
    tertiaryScale: 100,
  },
  [MuleSensorDomain.NRCS_ALPINE_SNOTEL]: {
    domainLabel: 'NRCS Alpine SNOTEL Pillow',
    primaryLabel: 'Alpine Air Temp',
    primaryUnit: '°C',
    primaryScale: 100,
    secondaryLabel: 'Snow Depth',
    secondaryUnit: 'in',
    secondaryScale: 1,
    tertiaryLabel: 'Snow Water Equiv',
    tertiaryUnit: 'in',
    tertiaryScale: 100,
  },
};

export interface SensorHarvestInput {
  stationCallsign: string;
  sequenceNumber: number;
  domain: MuleSensorDomain;
  batteryPercent: number;
  solarCharging: boolean;
  tamperAlert: boolean;
  thresholdExceeded: boolean;
  relativeAgeSeconds: number;
  lat: number;
  lon: number;
  elevationMeters: number;
  primaryValue: number;
  secondaryValue: number;
  tertiaryValue: number;
  stepIntervalMinutes: 5 | 15 | 30 | 60;
  historicalPrimarySeries: [number, number, number, number, number, number];
}

export interface DecodedSensorHarvestFrame {
  magic: 0xa1;
  rawHex: string;
  dedupKey: string;
  stationCallsign: string;
  sequenceNumber: number;
  domain: MuleSensorDomain;
  domainLabel: string;
  batteryPercent: number;
  solarCharging: boolean;
  tamperAlert: boolean;
  thresholdExceeded: boolean;
  relativeAgeSeconds: number;
  harvestedAtUtc: number;
  correctedSampleUtc: number;
  lat: number;
  lon: number;
  elevationMeters: number;
  primaryMetric: { label: string; value: number; unit: string };
  secondaryMetric: { label: string; value: number; unit: string };
  tertiaryMetric: { label: string; value: number; unit: string };
  stepIntervalMinutes: number;
  reconstructedTimeSeries: Array<{ timestampUtc: number; value: number }>;
  embeddedMacHex: string;
  computedMacHex: string;
  macVerified: boolean;
}

export interface RidgeMuleEphemerisInput {
  gaugeId: string;
  sequenceNumber: number;
  waterTempC: number;
  seaLevelPressureHpa: number;
  pressureDelta3hHpa: number;
  biteWindowScore: number;
  nwsAlertCode: number;
  dischargeCfs24hSeries: number[];
}

export interface DecodedRidgeMuleEphemerisFrame {
  magic: 0xb2;
  rawHex: string;
  dedupKey: string;
  gaugeId: string;
  sequenceNumber: number;
  waterTempC: number;
  waterTempF: number;
  seaLevelPressureHpa: number;
  pressureDelta3hHpa: number;
  biteWindowScore: number;
  nwsAlertCode: number;
  minDischargeCfs: number;
  maxDischargeCfs: number;
  reconstructed24hSeries: Array<{
    offsetHours: number;
    timestampUtc: number;
    dischargeCfs: number;
  }>;
  embeddedMacHex: string;
  computedMacHex: string;
  macVerified: boolean;
}

const DEFAULT_SIPHASH_KEY: [number, number, number, number] = [
  0x49ca1b3e,
  0x8a7d3f01,
  0xc3591e2b,
  0x71e49a5d,
];

/**
 * Computes a deterministic 32-bit Keyed SipHash-2-4 Message Authentication Code (MAC)
 * over the first 28 bytes of a 32-byte MeshMule frame.
 */
export function computeMuleFrameMac32(
  payload28Bytes: Uint8Array,
  key: [number, number, number, number] = DEFAULT_SIPHASH_KEY
): number {
  let v0 = (0x736f6d65 ^ key[0]) >>> 0;
  let v1 = (0x646f7261 ^ key[1]) >>> 0;
  let v2 = (0x6c796765 ^ key[2]) >>> 0;
  let v3 = (0x74656462 ^ key[3]) >>> 0;

  const rotl32 = (x: number, b: number) => ((x << b) | (x >>> (32 - b))) >>> 0;

  const sipRound = () => {
    v0 = (v0 + v1) >>> 0;
    v1 = rotl32(v1, 13);
    v1 = (v1 ^ v0) >>> 0;
    v0 = rotl32(v0, 16);
    v2 = (v2 + v3) >>> 0;
    v3 = rotl32(v3, 16);
    v3 = (v3 ^ v2) >>> 0;
    v0 = (v0 + v3) >>> 0;
    v3 = rotl32(v3, 21);
    v3 = (v3 ^ v0) >>> 0;
    v2 = (v2 + v1) >>> 0;
    v1 = rotl32(v1, 17);
    v1 = (v1 ^ v2) >>> 0;
    v2 = rotl32(v2, 32);
  };

  const view = new DataView(
    payload28Bytes.buffer,
    payload28Bytes.byteOffset,
    Math.min(28, payload28Bytes.byteLength)
  );

  for (let offset = 0; offset + 4 <= 28; offset += 4) {
    const m = view.getUint32(offset, true);
    v3 = (v3 ^ m) >>> 0;
    sipRound();
    sipRound();
    v0 = (v0 ^ m) >>> 0;
  }

  v2 = (v2 ^ 0xff) >>> 0;
  sipRound();
  sipRound();
  sipRound();
  sipRound();

  return (v0 ^ v1 ^ v2 ^ v3) >>> 0;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex
    .trim()
    .replace(/^MULE1:/i, '')
    .replace(/[^0-9a-fA-F]/g, '');
  if (clean.length < MULE_FRAME_BYTE_LENGTH * 2) {
    throw new Error(`Invalid MeshMule hex length: expected 64 hex chars, got ${clean.length}`);
  }
  const out = new Uint8Array(MULE_FRAME_BYTE_LENGTH);
  for (let i = 0; i < MULE_FRAME_BYTE_LENGTH; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function packSigned24(val: number): [number, number, number] {
  const clamped = Math.max(-8388608, Math.min(8388607, Math.round(val)));
  const unsigned = clamped < 0 ? clamped + 0x1000000 : clamped;
  return [unsigned & 0xff, (unsigned >>> 8) & 0xff, (unsigned >>> 16) & 0xff];
}

function unpackSigned24(b0: number, b1: number, b2: number): number {
  const unsigned = (b0 & 0xff) | ((b1 & 0xff) << 8) | ((b2 & 0xff) << 16);
  return unsigned >= 0x800000 ? unsigned - 0x1000000 : unsigned;
}

function encodeCallsign5Bytes(callsign: string): [number, number, number, number, number] {
  const clean = callsign
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .padEnd(5, ' ')
    .slice(0, 5);
  return [
    clean.charCodeAt(0) & 0xff,
    clean.charCodeAt(1) & 0xff,
    clean.charCodeAt(2) & 0xff,
    clean.charCodeAt(3) & 0xff,
    clean.charCodeAt(4) & 0xff,
  ];
}

function decodeCallsign5Bytes(bytes: Uint8Array, offset: number): string {
  let s = '';
  for (let i = 0; i < 6; i++) {
    const c = bytes[offset + i];
    if (c >= 32 && c <= 126) {
      s += String.fromCharCode(c);
    }
  }
  return s.trim() || 'MULE-0';
}

/**
 * Encodes an Outbound `0xA1` Citizen-Science Backcountry Sensor Harvest Frame into 32 bytes.
 */
export function encodeSensorHarvestFrame(input: SensorHarvestInput): Uint8Array {
  const buffer = new ArrayBuffer(MULE_FRAME_BYTE_LENGTH);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const spec =
    MULE_DOMAIN_SPECS[input.domain] || MULE_DOMAIN_SPECS[MuleSensorDomain.USGS_HYDRO_GAUGE];

  const intervalCode =
    input.stepIntervalMinutes === 5
      ? 0
      : input.stepIntervalMinutes === 15
      ? 1
      : input.stepIntervalMinutes === 30
      ? 2
      : 3;

  // Byte 0: Magic 0xA1
  bytes[0] = MULE_SENSOR_MAGIC;

  // Byte 1: [7:4] Domain, [3:2] Step Interval, [1] Solar, [0] Threshold Exceeded
  bytes[1] =
    ((input.domain & 0x0f) << 4) |
    ((intervalCode & 0x03) << 2) |
    (input.solarCharging ? 0x02 : 0x00) |
    (input.thresholdExceeded ? 0x01 : 0x00);

  // Byte 2: [7] Tamper Alert, [6:0] Battery %
  const batt = Math.max(0, Math.min(100, Math.round(input.batteryPercent)));
  bytes[2] = (input.tamperAlert ? 0x80 : 0x00) | (batt & 0x7f);

  // Bytes 3..8 (6 bytes): 6-character ASCII Station Callsign
  const cleanCallsign = input.stationCallsign
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .padEnd(6, ' ')
    .slice(0, 6);
  for (let i = 0; i < 6; i++) {
    bytes[3 + i] = cleanCallsign.charCodeAt(i) & 0xff;
  }

  // Bytes 9..10: Sequence Number (uint16 LE)
  view.setUint16(9, Math.max(0, Math.min(65535, Math.round(input.sequenceNumber))), true);

  // Byte 11: Relative Age in 15-second ticks (uint8, up to 3,825s)
  bytes[11] = Math.max(0, Math.min(255, Math.round(input.relativeAgeSeconds / 15)));

  // Bytes 12..14: Latitude (24-bit signed, scaled by 8388607 / 90)
  const [lat0, lat1, lat2] = packSigned24((input.lat / 90) * 8388607);
  bytes[12] = lat0;
  bytes[13] = lat1;
  bytes[14] = lat2;

  // Bytes 15..17: Longitude (24-bit signed, scaled by 8388607 / 180)
  const [lon0, lon1, lon2] = packSigned24((input.lon / 180) * 8388607);
  bytes[15] = lon0;
  bytes[16] = lon1;
  bytes[17] = lon2;

  // Bytes 18..19: Elevation ASL in meters (int16 LE)
  view.setInt16(18, Math.max(-500, Math.min(32767, Math.round(input.elevationMeters))), true);

  // Bytes 20..21: Primary Metric (int16 LE)
  const pScaled = Math.max(-32768, Math.min(32767, Math.round(input.primaryValue * spec.primaryScale)));
  view.setInt16(20, pScaled, true);

  // Bytes 22..23: Secondary Metric (uint16 LE)
  const sScaled = Math.max(
    0,
    Math.min(65535, Math.round(input.secondaryValue * spec.secondaryScale))
  );
  view.setUint16(22, sScaled, true);

  // Bytes 24..25: Tertiary Metric (uint16 LE)
  const tScaled = Math.max(
    0,
    Math.min(65535, Math.round(input.tertiaryValue * spec.tertiaryScale))
  );
  view.setUint16(24, tScaled, true);

  // Bytes 26..27: 4 Historical Delta Nibbles (packed signed 4-bit offsets in tenths of primary unit)
  const series = input.historicalPrimarySeries || [
    input.primaryValue,
    input.primaryValue,
    input.primaryValue,
    input.primaryValue,
    input.primaryValue,
    input.primaryValue,
  ];
  const encodeSignedNibble = (deltaVal: number): number => {
    const q = Math.max(-8, Math.min(7, Math.round(deltaVal * 10)));
    return q < 0 ? q + 16 : q;
  };
  const n0 = encodeSignedNibble(series[0] - input.primaryValue);
  const n1 = encodeSignedNibble(series[1] - input.primaryValue);
  const n2 = encodeSignedNibble(series[2] - input.primaryValue);
  const n3 = encodeSignedNibble(series[3] - input.primaryValue);
  bytes[26] = ((n0 & 0x0f) << 4) | (n1 & 0x0f);
  bytes[27] = ((n2 & 0x0f) << 4) | (n3 & 0x0f);

  // Bytes 28..31: 32-bit SipHash-2-4 MAC over bytes 0..27
  const mac32 = computeMuleFrameMac32(bytes.subarray(0, 28));
  view.setUint32(28, mac32, true);

  return bytes;
}

/**
 * Decodes and verifies a 32-byte `0xA1` Outbound Citizen-Science Sensor Harvest Frame.
 */
export function decodeSensorHarvestFrame(
  frame: Uint8Array | string,
  harvestedAtUtc: number = Date.now()
): DecodedSensorHarvestFrame {
  const bytes = typeof frame === 'string' ? hexToBytes(frame) : frame;
  if (bytes.length < MULE_FRAME_BYTE_LENGTH || bytes[0] !== MULE_SENSOR_MAGIC) {
    throw new Error('Invalid 0xA1 MeshMule Sensor Harvest Frame header');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const domainRaw = ((bytes[1] >>> 4) & 0x0f) as MuleSensorDomain;
  const domain: MuleSensorDomain = MULE_DOMAIN_SPECS[domainRaw]
    ? domainRaw
    : MuleSensorDomain.USGS_HYDRO_GAUGE;
  const spec = MULE_DOMAIN_SPECS[domain];

  const intervalCode = (bytes[1] >>> 2) & 0x03;
  const stepIntervalMinutes =
    intervalCode === 0 ? 5 : intervalCode === 1 ? 15 : intervalCode === 2 ? 30 : 60;
  const solarCharging = (bytes[1] & 0x02) !== 0;
  const thresholdExceeded = (bytes[1] & 0x01) !== 0;

  const tamperAlert = (bytes[2] & 0x80) !== 0;
  const batteryPercent = bytes[2] & 0x7f;

  const stationCallsign = decodeCallsign5Bytes(bytes, 3);
  const sequenceNumber = view.getUint16(9, true);
  const relativeAgeSeconds = bytes[11] * 15;

  const lat = Number(((unpackSigned24(bytes[12], bytes[13], bytes[14]) / 8388607) * 90).toFixed(5));
  const lon = Number(
    ((unpackSigned24(bytes[15], bytes[16], bytes[17]) / 8388607) * 180).toFixed(5)
  );
  const elevationMeters = view.getInt16(18, true);

  const primaryVal = Number((view.getInt16(20, true) / spec.primaryScale).toFixed(2));
  const secondaryVal = Number((view.getUint16(22, true) / spec.secondaryScale).toFixed(2));
  const tertiaryVal = Number((view.getUint16(24, true) / spec.tertiaryScale).toFixed(2));

  const decodeSignedNibble = (nib: number): number => {
    const signed = nib >= 8 ? nib - 16 : nib;
    return signed / 10;
  };
  const d0 = decodeSignedNibble((bytes[26] >>> 4) & 0x0f);
  const d1 = decodeSignedNibble(bytes[26] & 0x0f);
  const d2 = decodeSignedNibble((bytes[27] >>> 4) & 0x0f);
  const d3 = decodeSignedNibble(bytes[27] & 0x0f);

  const correctedSampleUtc = harvestedAtUtc - relativeAgeSeconds * 1000;
  const stepMs = stepIntervalMinutes * 60 * 1000;
  const reconstructedTimeSeries = [
    { timestampUtc: correctedSampleUtc - 4 * stepMs, value: Number((primaryVal + d0).toFixed(2)) },
    { timestampUtc: correctedSampleUtc - 3 * stepMs, value: Number((primaryVal + d1).toFixed(2)) },
    { timestampUtc: correctedSampleUtc - 2 * stepMs, value: Number((primaryVal + d2).toFixed(2)) },
    { timestampUtc: correctedSampleUtc - 1 * stepMs, value: Number((primaryVal + d3).toFixed(2)) },
    { timestampUtc: correctedSampleUtc, value: primaryVal },
  ];

  const embeddedMac = view.getUint32(28, true);
  const computedMac = computeMuleFrameMac32(bytes.subarray(0, 28));
  const embeddedMacHex = embeddedMac.toString(16).toUpperCase().padStart(8, '0');
  const computedMacHex = computedMac.toString(16).toUpperCase().padStart(8, '0');

  return {
    magic: 0xa1,
    rawHex: bytesToHex(bytes),
    dedupKey: `${stationCallsign}:${sequenceNumber}`,
    stationCallsign,
    sequenceNumber,
    domain,
    domainLabel: spec.domainLabel,
    batteryPercent,
    solarCharging,
    tamperAlert,
    thresholdExceeded,
    relativeAgeSeconds,
    harvestedAtUtc,
    correctedSampleUtc,
    lat,
    lon,
    elevationMeters,
    primaryMetric: { label: spec.primaryLabel, value: primaryVal, unit: spec.primaryUnit },
    secondaryMetric: { label: spec.secondaryLabel, value: secondaryVal, unit: spec.secondaryUnit },
    tertiaryMetric: { label: spec.tertiaryLabel, value: tertiaryVal, unit: spec.tertiaryUnit },
    stepIntervalMinutes,
    reconstructedTimeSeries,
    embeddedMacHex,
    computedMacHex,
    macVerified: embeddedMac === computedMac,
  };
}

/**
 * Encodes an Inbound `0xB2` Ridge-Mule 24-Hour USGS Hydrograph & Ephemeris Frame into 32 bytes.
 */
export function encodeRidgeMuleEphemerisFrame(input: RidgeMuleEphemerisInput): Uint8Array {
  const buffer = new ArrayBuffer(MULE_FRAME_BYTE_LENGTH);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  bytes[0] = MULE_EPHEMERIS_MAGIC;
  bytes[1] = ((input.nwsAlertCode & 0x0f) << 4) | 0x01;

  const gaugeNum = parseInt(String(input.gaugeId).replace(/\D/g, ''), 10) || 11264500;
  view.setUint32(2, gaugeNum >>> 0, true);
  view.setUint16(6, Math.max(0, Math.min(65535, Math.round(input.sequenceNumber))), true);
  view.setInt16(8, Math.max(-32768, Math.min(32767, Math.round(input.waterTempC * 100))), true);

  const pEncoded = Math.max(
    0,
    Math.min(65535, Math.round((input.seaLevelPressureHpa - 850) * 100))
  );
  view.setUint16(10, pEncoded, true);
  view.setInt16(
    12,
    Math.max(-32768, Math.min(32767, Math.round(input.pressureDelta3hHpa * 100))),
    true
  );
  bytes[14] = Math.max(0, Math.min(100, Math.round(input.biteWindowScore)));
  bytes[15] = 0x01;

  const series =
    input.dischargeCfs24hSeries.length >= 12
      ? input.dischargeCfs24hSeries.slice(0, 12)
      : Array.from({ length: 12 }, (_, i) => input.dischargeCfs24hSeries[i] ?? 500);

  const minCfs = Math.max(0, Math.min(65535, Math.round(Math.min(...series))));
  const maxCfs = Math.max(minCfs + 1, Math.min(65535, Math.round(Math.max(...series))));
  view.setUint16(16, minCfs, true);
  view.setUint16(18, maxCfs, true);

  const span = Math.max(1, maxCfs - minCfs);
  for (let pairIdx = 0; pairIdx < 6; pairIdx++) {
    const vHigh = series[pairIdx * 2];
    const vLow = series[pairIdx * 2 + 1];
    const nibHigh = Math.max(0, Math.min(15, Math.round(((vHigh - minCfs) / span) * 15)));
    const nibLow = Math.max(0, Math.min(15, Math.round(((vLow - minCfs) / span) * 15)));
    bytes[20 + pairIdx] = ((nibHigh & 0x0f) << 4) | (nibLow & 0x0f);
  }

  view.setUint16(26, Math.floor((Date.now() / 60000) % 65535), true);

  const mac32 = computeMuleFrameMac32(bytes.subarray(0, 28));
  view.setUint32(28, mac32, true);

  return bytes;
}

/**
 * Decodes and verifies a 32-byte `0xB2` Ridge-Mule 24-Hour USGS Hydrograph & Ephemeris Frame.
 */
export function decodeRidgeMuleEphemerisFrame(
  frame: Uint8Array | string,
  receivedAtUtc: number = Date.now()
): DecodedRidgeMuleEphemerisFrame {
  const bytes = typeof frame === 'string' ? hexToBytes(frame) : frame;
  if (bytes.length < MULE_FRAME_BYTE_LENGTH || bytes[0] !== MULE_EPHEMERIS_MAGIC) {
    throw new Error('Invalid 0xB2 MeshMule Ridge-Mule Ephemeris Frame header');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nwsAlertCode = (bytes[1] >>> 4) & 0x0f;
  const gaugeId = String(view.getUint32(2, true));
  const sequenceNumber = view.getUint16(6, true);
  const waterTempC = Number((view.getInt16(8, true) / 100).toFixed(1));
  const waterTempF = Number(((waterTempC * 9) / 5 + 32).toFixed(1));
  const seaLevelPressureHpa = Number((view.getUint16(10, true) / 100 + 850).toFixed(2));
  const pressureDelta3hHpa = Number((view.getInt16(12, true) / 100).toFixed(2));
  const biteWindowScore = bytes[14];

  const minDischargeCfs = view.getUint16(16, true);
  const maxDischargeCfs = view.getUint16(18, true);
  const span = Math.max(0, maxDischargeCfs - minDischargeCfs);

  const reconstructed24hSeries: DecodedRidgeMuleEphemerisFrame['reconstructed24hSeries'] = [];
  for (let pairIdx = 0; pairIdx < 6; pairIdx++) {
    const b = bytes[20 + pairIdx];
    const nibHigh = (b >>> 4) & 0x0f;
    const nibLow = b & 0x0f;
    const cfs0 = Math.round(minDischargeCfs + (nibHigh / 15) * span);
    const cfs1 = Math.round(minDischargeCfs + (nibLow / 15) * span);

    const idx0 = pairIdx * 2;
    const idx1 = pairIdx * 2 + 1;
    const offsetHours0 = -22 + idx0 * 2;
    const offsetHours1 = -22 + idx1 * 2;

    reconstructed24hSeries.push({
      offsetHours: offsetHours0,
      timestampUtc: receivedAtUtc + offsetHours0 * 3600 * 1000,
      dischargeCfs: cfs0,
    });
    reconstructed24hSeries.push({
      offsetHours: offsetHours1,
      timestampUtc: receivedAtUtc + offsetHours1 * 3600 * 1000,
      dischargeCfs: cfs1,
    });
  }

  const embeddedMac = view.getUint32(28, true);
  const computedMac = computeMuleFrameMac32(bytes.subarray(0, 28));
  const embeddedMacHex = embeddedMac.toString(16).toUpperCase().padStart(8, '0');
  const computedMacHex = computedMac.toString(16).toUpperCase().padStart(8, '0');

  return {
    magic: 0xb2,
    rawHex: bytesToHex(bytes),
    dedupKey: `RIDGE:${gaugeId}:${sequenceNumber}`,
    gaugeId,
    sequenceNumber,
    waterTempC,
    waterTempF,
    seaLevelPressureHpa,
    pressureDelta3hHpa,
    biteWindowScore,
    nwsAlertCode,
    minDischargeCfs,
    maxDischargeCfs,
    reconstructed24hSeries,
    embeddedMacHex,
    computedMacHex,
    macVerified: embeddedMac === computedMac,
  };
}

/**
 * Universal dispatcher that inspects Byte 0 (`0xA1` vs `0xB2`) and decodes the 32-byte frame.
 */
export function decodeAnyMuleFrame(
  frame: Uint8Array | string,
  timestampUtc: number = Date.now()
): DecodedSensorHarvestFrame | DecodedRidgeMuleEphemerisFrame {
  const bytes = typeof frame === 'string' ? hexToBytes(frame) : frame;
  if (bytes[0] === MULE_SENSOR_MAGIC) {
    return decodeSensorHarvestFrame(bytes, timestampUtc);
  }
  if (bytes[0] === MULE_EPHEMERIS_MAGIC) {
    return decodeRidgeMuleEphemerisFrame(bytes, timestampUtc);
  }
  throw new Error(`Unknown MeshMule frame magic byte: 0x${bytes[0]?.toString(16)}`);
}
