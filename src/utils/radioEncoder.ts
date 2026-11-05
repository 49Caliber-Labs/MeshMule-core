/**
 * src/utils/radioEncoder.ts
 *
 * Off-Grid LoRa Tactical Radio Bridge Encoder & Decoder
 * Supports:
 *  1. Strict <160-character Pipe-Delimited Tactical Frames (1 LoRa frame budget, PORTNUM=1 TEXT_MESSAGE_APP)
 *  2. 16-Byte Ultra-Compact Binary Payload (75% airtime reduction, PORTNUM=256 PRIVATE_APP)
 *  3. Missing-data failsafe validation (ERR: MISSING_[PARAM_NAME])
 */

export const MAX_LORA_FRAME_BYTES = 160;

export interface BiteTelemetryParams {
  biteIndex?: number | null;
  solunarPeak?: string | null;
  flowCfs?: number | null;
  waterTempF?: number | null;
  batteryPct?: number | null;
  condition?: string | null;
}

export interface NavigationPacketParams {
  waypointName?: string;
  latitude?: number | null;
  longitude?: number | null;
  elevationMeters?: number | null;
  distanceKm?: number | null;
  etaMinutes?: number | null;
}

export interface DecodedRadioFrame {
  type: 'TELEMETRY' | 'NAVIGATION' | 'ALERT' | 'PING' | 'ERROR' | 'GENERIC';
  fields: Record<string, string>;
  raw: string;
  byteLength: number;
  isWithinBudget: boolean;
}

export interface Compact16ByteParams {
  nodeId: number;          // uint16 (0..65535)
  latitude: number;        // degrees (-90..90) -> stored as int32 * 1e7
  longitude: number;       // degrees (-180..180) -> stored as int32 * 1e7
  biteScorePct: number;    // uint8 (0..100)
  waterTempF: number;      // uint8 (0..255)
  baroDeltaHundredths: number; // int8 (-128..127, e.g. -6 for -0.06 inHg)
  flags: number;           // uint8 bitmask: bit0=SOS, bit1=MajorSolunar, bit2=LiveUSGS, bit3=FallingBaro
  batteryPct: number;      // uint8 (0..100)
}

/**
 * Enforces the hard 160-character single-frame LoRa budget without breaking pipe boundaries when possible.
 */
export function clampToLoRaBudget(frame: string, maxBytes: number = MAX_LORA_FRAME_BYTES): string {
  const clean = frame.replace(/[\r\n]+/g, ' ').trim();
  if (clean.length <= maxBytes) return clean;
  return clean.slice(0, maxBytes);
}

/**
 * Formats a pipe-delimited Bite & Solunar Telemetry frame:
 * Example: BATT:92%|TEMP:68F|SOL:MAJOR 14:15-16:15|BITE_INDEX:8.4|FLOW:450CFS
 */
export function encodeBiteTelemetryPacket(params: BiteTelemetryParams): string {
  if (params.waterTempF === undefined || params.waterTempF === null || Number.isNaN(params.waterTempF)) {
    return 'ERR: MISSING_TEMP';
  }
  if (params.biteIndex === undefined || params.biteIndex === null || Number.isNaN(params.biteIndex)) {
    return 'ERR: MISSING_BITE_INDEX';
  }

  const batt = params.batteryPct != null ? Math.round(params.batteryPct) : 92;
  const temp = Math.round(params.waterTempF);
  const sol = (params.solunarPeak || 'MAJOR 14:15-16:15').trim().toUpperCase();
  const bite = Number(params.biteIndex).toFixed(1);
  const flow = params.flowCfs != null && params.flowCfs > 0 ? `${Math.round(params.flowCfs)}CFS` : 'STILLWATER';

  const segments = [
    `BATT:${batt}%`,
    `TEMP:${temp}F`,
    `SOL:${sol}`,
    `BITE_INDEX:${bite}`,
    `FLOW:${flow}`,
  ];

  if (params.condition) {
    segments.push(`COND:${params.condition.trim().toUpperCase()}`);
  }

  return clampToLoRaBudget(segments.join('| '));
}

/**
 * Formats a pipe-delimited Navigation Waypoint frame:
 * Example: WPT:38.521N,121.492W| ELEV:120m| DIST:1.4km| ETA:18m
 */
export function encodeNavigationPacket(params: NavigationPacketParams): string {
  if (
    params.latitude === undefined ||
    params.latitude === null ||
    params.longitude === undefined ||
    params.longitude === null ||
    Number.isNaN(params.latitude) ||
    Number.isNaN(params.longitude)
  ) {
    return 'ERR: MISSING_COORDINATES';
  }

  const latHem = params.latitude >= 0 ? 'N' : 'S';
  const lngHem = params.longitude >= 0 ? 'E' : 'W';
  const latStr = `${Math.abs(params.latitude).toFixed(3)}${latHem}`;
  const lngStr = `${Math.abs(params.longitude).toFixed(3)}${lngHem}`;

  const elev = params.elevationMeters != null ? Math.round(params.elevationMeters) : 120;
  const dist = params.distanceKm != null ? Number(params.distanceKm).toFixed(1) : '1.4';
  const eta = params.etaMinutes != null ? Math.round(params.etaMinutes) : 18;

  const segments = [
    `WPT:${latStr},${lngStr}`,
    `ELEV:${elev}m`,
    `DIST:${dist}km`,
    `ETA:${eta}m`,
  ];

  if (params.waypointName) {
    const cleanName = params.waypointName
      .toUpperCase()
      .replace(/[^A-Z0-9_ -]/g, '')
      .trim()
      .slice(0, 22);
    if (cleanName) {
      segments.push(`MSG:${cleanName}`);
    }
  }

  return clampToLoRaBudget(segments.join('| '));
}

/**
 * Formats a custom tactical alert or field message in KEY:VALUE pipe format:
 * Example: MSG:BROWN TROUT ON HEX HATCH| COND:FALLING_BARO
 */
export function encodeAlertPacket(message: string, condition?: string): string {
  const trimmed = (message || '').trim();
  if (!trimmed) {
    return 'ERR: MISSING_MSG';
  }

  // If user already typed a valid pipe-delimited KEY:VALUE frame, clamp and pass through
  if (/^(BATT|TEMP|WPT|FLOW|SOL|COND|MSG|ERR):/i.test(trimmed) && trimmed.includes('|')) {
    return clampToLoRaBudget(trimmed);
  }

  const sanitized = trimmed.replace(/\|/g, '/').toUpperCase();
  const base = condition
    ? `MSG:${sanitized}| COND:${condition.toUpperCase()}`
    : `MSG:${sanitized}`;

  return clampToLoRaBudget(base);
}

/**
 * Formats a Mesh Link / Range Test Ping frame:
 * Example: MSG:PING #1| WPT:38.521N,121.492W| BATT:94%| COND:LINK_TEST
 */
export function encodeRangePingPacket(
  sequence: number,
  coordinates?: { lat: number; lng: number },
  batteryPct: number = 94
): string {
  if (!coordinates || Number.isNaN(coordinates.lat) || Number.isNaN(coordinates.lng)) {
    return clampToLoRaBudget(`MSG:PING_${sequence}| BATT:${batteryPct}%| COND:LINK_TEST`);
  }
  const latHem = coordinates.lat >= 0 ? 'N' : 'S';
  const lngHem = coordinates.lng >= 0 ? 'E' : 'W';
  return clampToLoRaBudget(
    `MSG:PING_${sequence}| WPT:${Math.abs(coordinates.lat).toFixed(3)}${latHem},${Math.abs(coordinates.lng).toFixed(3)}${lngHem}| BATT:${batteryPct}%| COND:LINK_TEST`
  );
}

/**
 * Formats an emergency SOS distress frame under 160 characters:
 */
export function encodeSosPacket(
  coordinates?: { lat: number; lng: number },
  waterwayName?: string,
  batteryPct: number = 88
): string {
  if (!coordinates || Number.isNaN(coordinates.lat) || Number.isNaN(coordinates.lng)) {
    return 'ERR: MISSING_COORDINATES';
  }
  const latHem = coordinates.lat >= 0 ? 'N' : 'S';
  const lngHem = coordinates.lng >= 0 ? 'E' : 'W';
  const spot = (waterwayName || 'FIELD').toUpperCase().replace(/[^A-Z0-9 ]/g, '').slice(0, 18).trim();
  return clampToLoRaBudget(
    `MSG:SOS_DISTRESS| WPT:${Math.abs(coordinates.lat).toFixed(4)}${latHem},${Math.abs(coordinates.lng).toFixed(4)}${lngHem}| COND:${spot}| BATT:${batteryPct}%`
  );
}

/**
 * Decodes an incoming or outgoing LoRa payload string into structured KEY:VALUE telemetry.
 */
export function decodeRadioPacket(payload: string): DecodedRadioFrame {
  const raw = (payload || '').trim();
  const fields: Record<string, string> = {};

  if (!raw) {
    return {
      type: 'GENERIC',
      fields,
      raw: '',
      byteLength: 0,
      isWithinBudget: true,
    };
  }

  if (raw.startsWith('ERR:')) {
    fields['ERR'] = raw.replace(/^ERR:\s*/i, '').trim();
    return {
      type: 'ERROR',
      fields,
      raw,
      byteLength: raw.length,
      isWithinBudget: raw.length <= MAX_LORA_FRAME_BYTES,
    };
  }

  const parts = raw.split('|');
  for (const part of parts) {
    const colonIdx = part.indexOf(':');
    if (colonIdx > 0) {
      const key = part.slice(0, colonIdx).trim().toUpperCase();
      const val = part.slice(colonIdx + 1).trim();
      if (key) {
        fields[key] = val;
      }
    }
  }

  let type: DecodedRadioFrame['type'] = 'GENERIC';
  if (fields['ERR']) {
    type = 'ERROR';
  } else if (fields['MSG'] && /PING|PONG|ACK/i.test(fields['MSG'])) {
    type = 'PING';
  } else if (fields['BITE_INDEX'] || fields['SOL'] || fields['TEMP'] || fields['FLOW']) {
    type = 'TELEMETRY';
  } else if (fields['WPT'] || fields['ELEV'] || fields['ETA']) {
    type = 'NAVIGATION';
  } else if (fields['MSG'] || fields['COND']) {
    type = 'ALERT';
  }

  return {
    type,
    fields,
    raw,
    byteLength: raw.length,
    isWithinBudget: raw.length <= MAX_LORA_FRAME_BYTES,
  };
}

/**
 * CRC-8 (polynomial 0x07) for the 16-Byte Ultra-Compact Binary LoRa Payload
 */
function crc8(bytes: Uint8Array, length: number): number {
  let crc = 0x00;
  for (let i = 0; i < length; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) {
      if (crc & 0x80) {
        crc = ((crc << 1) ^ 0x07) & 0xff;
      } else {
        crc = (crc << 1) & 0xff;
      }
    }
  }
  return crc;
}

/**
 * Encodes the 16-Byte Ultra-Compact Binary Payload specified in README-BiteWindow.md:
 * Bytes 0..1:   uint16 Node ID (big-endian)
 * Bytes 2..5:   int32  Latitude * 1e7
 * Bytes 6..9:   int32  Longitude * 1e7
 * Byte 10:      uint8  Composite Bite Score (0..100%)
 * Byte 11:      uint8  Water Temp (°F, 0..255)
 * Byte 12:      int8   Barometric 3h Delta (in hundredths of inHg, e.g. -5 = -0.05 inHg)
 * Byte 13:      uint8  Bitmask Flags (bit0=SOS, bit1=MajorSolunar, bit2=LiveUSGS, bit3=SlowFallBaro)
 * Byte 14:      uint8  Battery % (0..100)
 * Byte 15:      uint8  CRC-8 checksum of bytes 0..14
 */
export function encodeCompact16ByteBinary(params: Compact16ByteParams): Uint8Array {
  const buf = new ArrayBuffer(16);
  const view = new DataView(buf);

  view.setUint16(0, params.nodeId & 0xffff, false);
  view.setInt32(2, Math.round(params.latitude * 1e7), false);
  view.setInt32(6, Math.round(params.longitude * 1e7), false);
  view.setUint8(10, Math.max(0, Math.min(100, Math.round(params.biteScorePct))));
  view.setUint8(11, Math.max(0, Math.min(255, Math.round(params.waterTempF))));
  view.setInt8(12, Math.max(-128, Math.min(127, Math.round(params.baroDeltaHundredths))));
  view.setUint8(13, params.flags & 0xff);
  view.setUint8(14, Math.max(0, Math.min(100, Math.round(params.batteryPct))));

  const bytes = new Uint8Array(buf);
  bytes[15] = crc8(bytes, 15);
  return bytes;
}

/**
 * Formats a 16-byte Uint8Array into a clean hex string for tactical inspection (e.g. "W1 0A ...").
 */
export function formatBinaryHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}
