/**
 * src/services/meshtasticRadioService.ts
 *
 * Universal Meshtastic LoRa Radio Interface (Web Bluetooth, Web Serial USB, & Wi-Fi HTTP).
 * Hardware-agnostic implementation supporting all Meshtastic-compatible transceivers.
 *
 * Extracts:
 *  - Connected Radio's own Node ID / 4-char screen suffix (`MyNodeInfo` tag 0x1a)
 *  - Hardware LoRa RF Config (`Config.LoRaConfig`: Region, ModemPreset, Frequency Slot, TX Enabled, Power, Hop Limit)
 *  - Primary Channel 0 Config (`Channel`: Role, Name, PSK Key Fingerprint)
 *  - Device Metadata (`DeviceMetadata`: Firmware Version, Hardware Model)
 *  - Mesh Peer NodeDB entries (`NodeInfo` tag 0x22: callsign, 4-char shortName, GPS, SNR, battery, hops)
 *  - Hardware TX Queue & Over-The-Air Routing ACK/Error status (`QueueStatus` tag 0x5a & `ROUTING_APP` portnum=5)
 *  - Live Text & Tactical Telemetry packets (`MeshPacket` tag 0x12, PORTNUM=1)
 *  - Live Hardware GPS Coordinates (`POSITION_APP` PORTNUM=3)
 */

import { clampToLoRaBudget, MAX_LORA_FRAME_BYTES } from '../utils/radioEncoder';
import { muleCollectorService } from '../mesh-core/muleCollectorService';
import { bytesToHex as muleBytesToHex } from '../mesh-core/muleCodec';

export type RadioConnectionStatus = 'disconnected' | 'bluetooth' | 'serial' | 'wifi';
export type ConnectionType = RadioConnectionStatus;
export type SerialFramingMode = 'meshtastic_protobuf' | 'raw_serial';

export interface PlatformCapabilities {
  isIOS: boolean;
  isAndroid: boolean;
  isDesktop: boolean;
  isSafari: boolean;
  isBluefy: boolean;
  hasWebBluetooth: boolean;
  hasWebSerial: boolean;
  recommendedTransport: 'bluetooth' | 'serial' | 'wifi' | 'bluefy_app';
  diagnosticNotice?: string;
}

export function detectPlatformCapabilities(): PlatformCapabilities {
  if (typeof navigator === 'undefined') {
    return {
      isIOS: false,
      isAndroid: false,
      isDesktop: true,
      isSafari: false,
      isBluefy: false,
      hasWebBluetooth: false,
      hasWebSerial: false,
      recommendedTransport: 'serial',
    };
  }

  const ua = navigator.userAgent || '';
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const isDesktop = !isIOS && !isAndroid;
  const hasWebBluetooth = 'bluetooth' in navigator;
  const hasWebSerial = 'serial' in navigator;
  const isBluefy = /Bluefy/i.test(ua) || (isIOS && hasWebBluetooth);
  const isSafari =
    /Safari/i.test(ua) && !/Chrome|CriOS|FxiOS|EdgiOS|Bluefy/i.test(ua);

  let recommendedTransport: 'bluetooth' | 'serial' | 'wifi' | 'bluefy_app' = 'serial';
  let diagnosticNotice: string | undefined;

  if (isIOS) {
    if (hasWebBluetooth) {
      recommendedTransport = 'bluetooth';
      diagnosticNotice =
        'Running inside iOS Web Bluetooth container (Bluefy). Direct BLE pairing is available!';
    } else {
      recommendedTransport = 'bluefy_app';
      diagnosticNotice =
        'iOS Safari blocks Web Bluetooth. Open this URL in the free Bluefy browser on iPhone for direct Bluetooth, or connect to the ESP32 Wi-Fi Hotspot.';
    }
  } else if (isAndroid) {
    if (hasWebBluetooth) {
      recommendedTransport = 'bluetooth';
    } else {
      recommendedTransport = 'wifi';
    }
  } else {
    if (hasWebSerial) {
      recommendedTransport = 'serial';
    } else if (hasWebBluetooth) {
      recommendedTransport = 'bluetooth';
    } else {
      recommendedTransport = 'wifi';
    }
  }

  return {
    isIOS,
    isAndroid,
    isDesktop,
    isSafari,
    isBluefy,
    hasWebBluetooth,
    hasWebSerial,
    recommendedTransport,
    diagnosticNotice,
  };
}

export interface LocalRadioIdentity {
  nodeNum: number;
  nodeHexId: string;   // e.g. "!a1b2c3d4"
  shortSuffix: string; // e.g. "c3d4" (matches the 4-char ID shown on the radio's physical screen)
  rebootCount?: number;
}

export interface RadioNode {
  id: string;
  nodeNum?: number;
  longName: string;
  shortName: string;
  batteryLevel?: number;
  snr?: number;
  rssi?: number;
  hopsAway?: number;
  lastHeard: Date;
  latitude?: number;
  longitude?: number;
  isLocalNode?: boolean;
}

export interface HardwareGpsFix {
  latitude: number;
  longitude: number;
  altitudeMeters?: number;
  satsInView?: number;
  updatedAt: Date;
  sourceNode: string;
}

export type DeliveryAckState = 'queued' | 'tx_queued' | 'ack_received' | 'failed';

export interface RadioPacket {
  id: string;
  meshPacketId?: number;
  sender: string;
  payload: string;
  timestamp: Date;
  rssi?: number;
  rssiDbm?: number;
  snrDb?: number;
  hopCount?: number;
  channelIndex?: number;
  direction: 'tx' | 'rx';
  gpsFix?: HardwareGpsFix;
  ackState?: DeliveryAckState;
  ackDetail?: string;
}

export interface RadioDiagnosticsSnapshot {
  capturedAt: Date;
  nodeHexId: string;
  shortSuffix: string;
  nodeNum: number;
  firmwareVersion?: string;
  hwModelId?: number;
  // LoRa Config
  usePreset?: boolean;
  modemPresetCode?: number;
  modemPresetName: string;
  regionCode?: number;
  regionName: string;
  hopLimit?: number;
  txEnabled?: boolean;
  txPowerDbm?: number;
  frequencySlot?: number;
  overrideFrequencyMhz?: number;
  // Primary Channel 0 Config
  primaryChannelName: string;
  primaryChannelPskHex: string;
  primaryChannelRole: string;
  // Live Counters & Queue
  framesRxCount: number;
  protoPacketsRxCount: number;
  configCompleteCount: number;
  queueFree?: number;
  queueMax?: number;
  lastRoutingStatus: string;
  lastRadioLogLine?: string;
  peerNodesInDb: number;
}

// Official Meshtastic BLE GATT UUIDs
const MESHTASTIC_SERVICE_UUID = '6ba1b218-15a8-461f-9fa8-5dcae273eafd';
const TORADIO_CHAR_UUID       = 'f75c76d2-129e-4dad-a1dd-7866124401e7';
const FROMRADIO_CHAR_UUID     = '2c55e69e-4993-11ed-b878-0242ac120002';
const FROMNUM_CHAR_UUID       = 'ed9da18c-a800-4f66-a670-aa7547e34453';

// Alternate Meshtastic BLE Service UUIDs
const ALT_BLE_SERVICE_UUID    = '6ba1b080-b1d1-46e4-a26b-7599e2157671';
const ALT_FROMRADIO_UUID      = '6ba1b081-b1d1-46e4-a26b-7599e2157671';
const ALT_TORADIO_UUID        = '6ba1b082-b1d1-46e4-a26b-7599e2157671';
const ALT_FROMNUM_UUID        = '6ba1b083-b1d1-46e4-a26b-7599e2157671';

// Nordic UART Service UUIDs (BLE Serial Bridge)
const NUS_SERVICE_UUID        = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX_CHAR_UUID        = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX_CHAR_UUID        = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

// Meshtastic Serial Stream Framing Magic Bytes
const MESH_START1 = 0x94;
const MESH_START2 = 0xc3;

// O(1) Ring Buffer Capacity
const RING_BUFFER_CAPACITY = 64;

const REGION_CODE_NAMES: Record<number, string> = {
  0: 'UNSET (TX Disabled!)',
  1: 'US (902–928 MHz)',
  2: 'EU_433',
  3: 'EU_868',
  4: 'CN',
  5: 'JP',
  6: 'ANZ',
  7: 'KR',
  8: 'TW',
  9: 'RU',
  10: 'IN',
  11: 'NZ_865',
  12: 'TH',
  13: 'LORA_24',
  14: 'UA_433',
  15: 'UA_868',
  16: 'MY_433',
  17: 'MY_919',
  18: 'SG_923',
};

const MODEM_PRESET_NAMES: Record<number, string> = {
  0: 'LONG_FAST (Default 250kHz)',
  1: 'LONG_SLOW',
  2: 'VERY_LONG_SLOW',
  3: 'MEDIUM_SLOW',
  4: 'MEDIUM_FAST',
  5: 'SHORT_SLOW',
  6: 'SHORT_FAST',
  7: 'LONG_MODERATE',
  8: 'SHORT_TURBO (500kHz)',
  9: 'LONG_TURBO (500kHz)',
  10: 'MEDIUM_TURBO (500kHz)',
};

const ROUTING_ERROR_NAMES: Record<number, string> = {
  0: 'ACK_RECEIVED (Delivered to peer radio over 915 MHz!)',
  1: 'NO_ROUTE (No route to destination node)',
  2: 'GOT_NAK (Peer rejected packet)',
  3: 'TIMEOUT (Delivery timed out)',
  4: 'NO_INTERFACE (LoRa transceiver disabled or Region UNSET)',
  5: 'MAX_RETRANSMIT (Sent 3x on 915 MHz — NO radio heard/acknowledged it)',
  6: 'NO_CHANNEL (Channel invalid or PSK mismatch)',
  7: 'TOO_LARGE (Payload exceeds LoRa MTU)',
  8: 'NO_RESPONSE (Peer did not respond)',
  9: 'DUTY_CYCLE_LIMIT (Airtime duty cycle exceeded)',
};

type StatusListener = (status: RadioConnectionStatus, deviceName?: string) => void;
type PacketListener = (packet: RadioPacket) => void;
type GpsListener = (fix: HardwareGpsFix) => void;
type NodesListener = (nodes: RadioNode[]) => void;
type LocalIdentityListener = (identity: LocalRadioIdentity | null) => void;
type DiagnosticsListener = (
  current: RadioDiagnosticsSnapshot,
  savedProfiles: RadioDiagnosticsSnapshot[]
) => void;

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return bytes;
}

function decodeVarint(bytes: Uint8Array, offset: number): { value: number; nextOffset: number } | null {
  let result = 0;
  let shift = 0;
  let idx = offset;
  while (idx < bytes.length && shift <= 35) {
    const byte = bytes[idx++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result >>> 0, nextOffset: idx };
    }
    shift += 7;
  }
  return null;
}

interface ProtoField {
  fieldNumber: number;
  wireType: number;
  varint?: number;
  fixed32?: number;
  bytes?: Uint8Array;
}

/**
 * Universal zero-dependency Protobuf wire-format reader.
 * Safely decodes top-level or nested Protobuf messages without throwing on unknown fields.
 */
function parseProtobufFields(buffer: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 0;

  while (offset < buffer.length) {
    const tagInfo = decodeVarint(buffer, offset);
    if (!tagInfo || tagInfo.value === 0) break;
    offset = tagInfo.nextOffset;

    const fieldNumber = tagInfo.value >>> 3;
    const wireType = tagInfo.value & 0x07;
    if (fieldNumber <= 0) break;

    if (wireType === 0) {
      // Varint
      const valInfo = decodeVarint(buffer, offset);
      if (!valInfo) break;
      offset = valInfo.nextOffset;
      fields.push({ fieldNumber, wireType, varint: valInfo.value });
    } else if (wireType === 1) {
      // 64-bit fixed
      if (offset + 8 > buffer.length) break;
      offset += 8;
      fields.push({ fieldNumber, wireType });
    } else if (wireType === 2) {
      // Length-delimited bytes / string / submessage
      const lenInfo = decodeVarint(buffer, offset);
      if (!lenInfo || lenInfo.value < 0 || lenInfo.nextOffset + lenInfo.value > buffer.length) break;
      const subBytes = buffer.slice(lenInfo.nextOffset, lenInfo.nextOffset + lenInfo.value);
      offset = lenInfo.nextOffset + lenInfo.value;
      fields.push({ fieldNumber, wireType, bytes: subBytes });
    } else if (wireType === 5) {
      // 32-bit fixed
      if (offset + 4 > buffer.length) break;
      const f32 = view.getUint32(offset, true);
      offset += 4;
      fields.push({ fieldNumber, wireType, fixed32: f32 });
    } else {
      // Unsupported wireType (3 or 4)
      break;
    }
  }

  return fields;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/**
 * Builds a standards-compliant Meshtastic `ToRadio` protobuf payload
 * containing a broadcast `MeshPacket` on `PORTNUM = 1` (`TEXT_MESSAGE_APP`).
 */
export function buildMeshtasticToRadioTextPacket(
  text: string,
  channelIndex: number = 0,
  ringSpeakerBell: boolean = false,
  destinationNodeNum: number = 0xffffffff
): { protoBytes: Uint8Array; packetId: number } {
  const encoder = new TextEncoder();
  const clampedText = clampToLoRaBudget(text, ringSpeakerBell ? MAX_LORA_FRAME_BYTES - 1 : MAX_LORA_FRAME_BYTES);
  const finalString = ringSpeakerBell ? `\x07${clampedText}` : clampedText;
  const textBytes = encoder.encode(finalString);

  // Data submessage: portnum = 1 (TEXT_MESSAGE_APP), payload = textBytes
  const dataMsg: number[] = [
    0x08, 0x01,
    0x12, ...encodeVarint(textBytes.length),
    ...Array.from(textBytes),
  ];

  const pktId = (Math.floor(Math.random() * 0x7fffffff) + 1) >>> 0;

  // MeshPacket: field 2 (`to`, fixed32 = 0x15)
  const meshPacket: number[] = [
    0x15,
    destinationNodeNum & 0xff,
    (destinationNodeNum >>> 8) & 0xff,
    (destinationNodeNum >>> 16) & 0xff,
    (destinationNodeNum >>> 24) & 0xff,
  ];

  if (channelIndex > 0) {
    meshPacket.push(0x18, ...encodeVarint(channelIndex));
  }

  meshPacket.push(
    0x22, ...encodeVarint(dataMsg.length), ...dataMsg,
    0x35,
    pktId & 0xff,
    (pktId >>> 8) & 0xff,
    (pktId >>> 16) & 0xff,
    (pktId >>> 24) & 0xff,
    0x48, 0x03, // hop_limit = 3
    0x50, 0x01  // want_ack = true
  );

  const toRadio: number[] = [
    0x0a, ...encodeVarint(meshPacket.length), ...meshPacket,
  ];

  return {
    protoBytes: new Uint8Array(toRadio),
    packetId: pktId,
  };
}

/**
 * Builds an AdminMessage (`PORTNUM = 6`, `ADMIN_APP`) wrapped in a `ToRadio` packet
 * addressed to the local connected node so BiteWindow can standardize its LoRa & Channel 0 config.
 */
function buildLocalAdminToRadioPacket(localNodeNum: number, adminPayloadBytes: number[]): Uint8Array {
  // Data submessage: portnum = 6 (ADMIN_APP), payload = adminPayloadBytes, want_response = true (field 3 = 0x18, 0x01)
  const dataMsg: number[] = [
    0x08, 0x06,
    0x12, ...encodeVarint(adminPayloadBytes.length),
    ...adminPayloadBytes,
    0x18, 0x01,
  ];

  const pktId = (Math.floor(Math.random() * 0x7fffffff) + 1) >>> 0;

  const meshPacket: number[] = [
    // field 1: `from` (fixed32 = 0x0d)
    0x0d,
    localNodeNum & 0xff,
    (localNodeNum >>> 8) & 0xff,
    (localNodeNum >>> 16) & 0xff,
    (localNodeNum >>> 24) & 0xff,
    // field 2: `to` (fixed32 = 0x15)
    0x15,
    localNodeNum & 0xff,
    (localNodeNum >>> 8) & 0xff,
    (localNodeNum >>> 16) & 0xff,
    (localNodeNum >>> 24) & 0xff,
    // field 4: `decoded` (tag 0x22)
    0x22, ...encodeVarint(dataMsg.length), ...dataMsg,
    // field 6: `id` (fixed32 = 0x35)
    0x35,
    pktId & 0xff,
    (pktId >>> 8) & 0xff,
    (pktId >>> 16) & 0xff,
    (pktId >>> 24) & 0xff,
    // field 10: `want_ack` = true
    0x50, 0x01,
  ];

  return new Uint8Array([0x0a, ...encodeVarint(meshPacket.length), ...meshPacket]);
}

/**
 * Builds the Meshtastic `ToRadio { want_config_id }` handshake packet
 * to request the connected radio's MyNodeInfo, LoRaConfig, Channels, NodeDB, and live stream.
 */
function buildMeshtasticWantConfigPacket(configId: number = 69420): Uint8Array {
  return new Uint8Array([0x18, ...encodeVarint(configId)]);
}

/**
 * Wraps a `ToRadio` protobuf payload in the 4-byte Meshtastic Serial Stream header:
 * [0x94, 0xC3, msb_length, lsb_length, ...protobufBytes]
 */
export function wrapMeshtasticSerialFrame(protoBytes: Uint8Array): Uint8Array {
  const len = protoBytes.length;
  const framed = new Uint8Array(4 + len);
  framed[0] = MESH_START1;
  framed[1] = MESH_START2;
  framed[2] = (len >>> 8) & 0xff;
  framed[3] = len & 0xff;
  framed.set(protoBytes, 4);
  return framed;
}

/**
 * Extracts a hardware GPS fix from a Meshtastic POSITION_APP (portnum=3) protobuf payload.
 */
function tryExtractPositionFromProtobuf(bytes: Uint8Array): HardwareGpsFix | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < bytes.length - 12; i++) {
    if (bytes[i] === 0x0d && bytes[i + 5] === 0x15) {
      const latI = view.getInt32(i + 1, true);
      const lonI = view.getInt32(i + 6, true);
      const lat = latI * 1e-7;
      const lon = lonI * 1e-7;
      if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && (Math.abs(lat) > 0.1 || Math.abs(lon) > 0.1)) {
        return {
          latitude: Number(lat.toFixed(6)),
          longitude: Number(lon.toFixed(6)),
          updatedAt: new Date(),
          sourceNode: 'RADIO_GPS',
        };
      }
    }
  }
  return null;
}

export class MeshtasticRadioService {
  private connectionStatus: RadioConnectionStatus = 'disconnected';
  private deviceName: string = 'No Radio Connected';
  private localIdentity: LocalRadioIdentity | null = null;
  private framingMode: SerialFramingMode = 'meshtastic_protobuf';
  private bellAlertEnabled: boolean = false;
  private wifiHost: string = 'meshtastic.local';
  private wifiPollTimer: any = null;
  private lastHardwareGpsFix: HardwareGpsFix | null = null;

  private packetRing: RadioPacket[] = [];
  private discoveredNodes = new Map<string, RadioNode>();
  private savedRadioProfiles = new Map<string, RadioDiagnosticsSnapshot>();

  private diagnostics: RadioDiagnosticsSnapshot = {
    capturedAt: new Date(),
    nodeHexId: 'Unknown (Waiting for USB/BLE Handshake)',
    shortSuffix: '----',
    nodeNum: 0,
    modemPresetName: 'Reading from radio...',
    regionName: 'Reading from radio...',
    primaryChannelName: 'Reading...',
    primaryChannelPskHex: 'Reading...',
    primaryChannelRole: 'PRIMARY',
    framesRxCount: 0,
    protoPacketsRxCount: 0,
    configCompleteCount: 0,
    lastRoutingStatus: 'No packets transmitted in this session yet',
    peerNodesInDb: 0,
  };

  private statusListeners = new Set<StatusListener>();
  private packetListeners = new Set<PacketListener>();
  private gpsListeners = new Set<GpsListener>();
  private nodesListeners = new Set<NodesListener>();
  private identityListeners = new Set<LocalIdentityListener>();
  private diagnosticsListeners = new Set<DiagnosticsListener>();

  private bleDevice: any = null;
  private bleServer: any = null;
  private bleToRadioChar: any = null;
  private bleFromRadioChar: any = null;
  private bleFromNumChar: any = null;
  private isBleUartFallback: boolean = false;

  private serialPort: any = null;
  private serialReader: any = null;
  private serialKeepReading: boolean = false;

  private pingCounter: number = 1;

  public getConnectionStatus(): RadioConnectionStatus {
    return this.connectionStatus;
  }

  public getDeviceName(): string {
    return this.deviceName;
  }

  public getLocalIdentity(): LocalRadioIdentity | null {
    return this.localIdentity;
  }

  public getDiagnostics(): RadioDiagnosticsSnapshot {
    return { ...this.diagnostics };
  }

  public getSavedRadioProfiles(): RadioDiagnosticsSnapshot[] {
    return Array.from(this.savedRadioProfiles.values());
  }

  public getFramingMode(): SerialFramingMode {
    return this.framingMode;
  }

  public setFramingMode(mode: SerialFramingMode): void {
    this.framingMode = mode;
  }

  public isBellAlertEnabled(): boolean {
    return this.bellAlertEnabled;
  }

  public setBellAlertEnabled(enabled: boolean): void {
    this.bellAlertEnabled = enabled;
  }

  public getWifiHost(): string {
    return this.wifiHost;
  }

  public setWifiHost(host: string): void {
    this.wifiHost = host.replace(/^https?:\/\//i, '').replace(/\/+$/, '').trim() || 'meshtastic.local';
  }

  public getLastHardwareGpsFix(): HardwareGpsFix | null {
    return this.lastHardwareGpsFix;
  }

  public getPacketHistory(): RadioPacket[] {
    return [...this.packetRing];
  }

  public getDiscoveredNodes(): RadioNode[] {
    return Array.from(this.discoveredNodes.values()).sort(
      (a, b) => b.lastHeard.getTime() - a.lastHeard.getTime()
    );
  }

  public getNextPingSequence(): number {
    return this.pingCounter++;
  }

  public onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  public onPacketReceived(listener: PacketListener): () => void {
    this.packetListeners.add(listener);
    return () => {
      this.packetListeners.delete(listener);
    };
  }

  public onGpsFixReceived(listener: GpsListener): () => void {
    this.gpsListeners.add(listener);
    return () => {
      this.gpsListeners.delete(listener);
    };
  }

  public onNodesUpdated(listener: NodesListener): () => void {
    this.nodesListeners.add(listener);
    return () => {
      this.nodesListeners.delete(listener);
    };
  }

  public onLocalIdentityUpdated(listener: LocalIdentityListener): () => void {
    this.identityListeners.add(listener);
    return () => {
      this.identityListeners.delete(listener);
    };
  }

  public onDiagnosticsUpdated(listener: DiagnosticsListener): () => void {
    this.diagnosticsListeners.add(listener);
    return () => {
      this.diagnosticsListeners.delete(listener);
    };
  }

  private emitDiagnostics() {
    this.diagnostics.capturedAt = new Date();
    const peerCount = Array.from(this.discoveredNodes.values()).filter((n) => !n.isLocalNode).length;
    this.diagnostics.peerNodesInDb = peerCount;

    if (this.diagnostics.nodeNum > 0 && this.diagnostics.nodeHexId.startsWith('!')) {
      this.savedRadioProfiles.set(this.diagnostics.nodeHexId, { ...this.diagnostics });
    }

    const snap = this.getDiagnostics();
    const profiles = this.getSavedRadioProfiles();
    if (import.meta.env.DEV && typeof fetch !== 'undefined') {
      fetch('/__radio_diag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeHexId: snap.nodeHexId,
          shortSuffix: snap.shortSuffix,
          regionName: snap.regionName,
          modemPresetName: snap.modemPresetName,
          frequencySlot: snap.frequencySlot,
          txEnabled: snap.txEnabled,
          primaryChannelName: snap.primaryChannelName,
          primaryChannelPskHex: snap.primaryChannelPskHex,
          lastRoutingStatus: snap.lastRoutingStatus,
          lastRadioLogLine: snap.lastRadioLogLine,
          peerNodesInDb: snap.peerNodesInDb,
        }),
      }).catch(() => {});
    }
    for (const listener of this.diagnosticsListeners) {
      listener(snap, profiles);
    }
  }

  private setStatus(status: RadioConnectionStatus, name?: string) {
    this.connectionStatus = status;
    if (name) this.deviceName = name;
    for (const listener of this.statusListeners) {
      listener(this.connectionStatus, this.deviceName);
    }
  }

  private setLocalIdentity(identity: LocalRadioIdentity | null) {
    this.localIdentity = identity;
    if (identity) {
      this.deviceName = `Radio _${identity.shortSuffix} (${identity.nodeHexId})`;
      this.diagnostics.nodeNum = identity.nodeNum;
      this.diagnostics.nodeHexId = identity.nodeHexId;
      this.diagnostics.shortSuffix = identity.shortSuffix;
      for (const listener of this.statusListeners) {
        listener(this.connectionStatus, this.deviceName);
      }
      this.emitDiagnostics();
    }
    for (const listener of this.identityListeners) {
      listener(this.localIdentity);
    }
  }

  private emitGpsFix(fix: HardwareGpsFix) {
    this.lastHardwareGpsFix = fix;
    for (const listener of this.gpsListeners) {
      listener(fix);
    }
  }

  private upsertNode(nodeId: string, partial: Partial<RadioNode>) {
    const existing = this.discoveredNodes.get(nodeId);
    const isSelf = this.localIdentity?.nodeHexId === nodeId;
    const updated: RadioNode = {
      id: nodeId,
      nodeNum: partial.nodeNum ?? existing?.nodeNum,
      longName: partial.longName || existing?.longName || `Meshtastic ${nodeId.slice(-4)}`,
      shortName: partial.shortName || existing?.shortName || nodeId.slice(-4).toUpperCase(),
      batteryLevel: partial.batteryLevel ?? existing?.batteryLevel,
      snr: partial.snr ?? existing?.snr,
      rssi: partial.rssi ?? existing?.rssi,
      hopsAway: partial.hopsAway ?? existing?.hopsAway,
      latitude: partial.latitude ?? existing?.latitude,
      longitude: partial.longitude ?? existing?.longitude,
      isLocalNode: isSelf || partial.isLocalNode || existing?.isLocalNode,
      lastHeard: partial.lastHeard || existing?.lastHeard || new Date(),
    };
    this.discoveredNodes.set(nodeId, updated);
    const list = this.getDiscoveredNodes();
    for (const listener of this.nodesListeners) {
      listener(list);
    }
    this.emitDiagnostics();
  }

  /**
   * Parses a complete `FromRadio` protobuf packet using proper wire-format decoding.
   */
  private handleIncomingFromRadioBytes(bytes: Uint8Array) {
    this.diagnostics.protoPacketsRxCount += 1;
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const topFields = parseProtobufFields(bytes);

    for (const field of topFields) {
      // Field 3 (tag 0x1a): MyNodeInfo
      if (field.fieldNumber === 3 && field.bytes) {
        const myFields = parseProtobufFields(field.bytes);
        const nodeNumField = myFields.find((f) => f.fieldNumber === 1 && f.varint !== undefined);
        const rebootField = myFields.find((f) => f.fieldNumber === 8 && f.varint !== undefined);
        if (nodeNumField && nodeNumField.varint && nodeNumField.varint !== 0xffffffff) {
          const hex = nodeNumField.varint.toString(16).padStart(8, '0').toLowerCase();
          const identity: LocalRadioIdentity = {
            nodeNum: nodeNumField.varint,
            nodeHexId: `!${hex}`,
            shortSuffix: hex.slice(-4),
            rebootCount: rebootField?.varint,
          };
          this.setLocalIdentity(identity);
          this.upsertNode(identity.nodeHexId, {
            nodeNum: identity.nodeNum,
            longName: `Connected Radio (_${identity.shortSuffix})`,
            shortName: identity.shortSuffix.toUpperCase(),
            isLocalNode: true,
          });
        }
      }

      // Field 4 (tag 0x22): NodeInfo (from radio's internal NodeDB)
      if (field.fieldNumber === 4 && field.bytes) {
        const nf = parseProtobufFields(field.bytes);
        const numField = nf.find((f) => f.fieldNumber === 1 && f.varint !== undefined);
        const userField = nf.find((f) => f.fieldNumber === 2 && f.bytes !== undefined);
        const posField = nf.find((f) => f.fieldNumber === 3 && f.bytes !== undefined);
        const snrField = nf.find((f) => f.fieldNumber === 4 && f.fixed32 !== undefined);
        const lastHeardField = nf.find((f) => f.fieldNumber === 5 && f.fixed32 !== undefined);
        const metricsField = nf.find((f) => f.fieldNumber === 6 && f.bytes !== undefined);
        const hopsField = nf.find((f) => f.fieldNumber === 9 && f.varint !== undefined);

        let nodeHexId: string | undefined;
        let longName: string | undefined;
        let shortName: string | undefined;

        if (numField?.varint && numField.varint !== 0xffffffff) {
          nodeHexId = `!${numField.varint.toString(16).padStart(8, '0').toLowerCase()}`;
        }

        if (userField?.bytes) {
          const uf = parseProtobufFields(userField.bytes);
          const idStr = uf.find((f) => f.fieldNumber === 1 && f.bytes);
          const longStr = uf.find((f) => f.fieldNumber === 2 && f.bytes);
          const shortStr = uf.find((f) => f.fieldNumber === 3 && f.bytes);
          if (idStr?.bytes) {
            const decodedId = decoder.decode(idStr.bytes).trim();
            if (decodedId.startsWith('!')) nodeHexId = decodedId.toLowerCase();
          }
          if (longStr?.bytes) longName = decoder.decode(longStr.bytes).trim();
          if (shortStr?.bytes) shortName = decoder.decode(shortStr.bytes).trim();
        }

        let snrDb: number | undefined;
        if (snrField?.fixed32 !== undefined) {
          const tmp = new DataView(new ArrayBuffer(4));
          tmp.setUint32(0, snrField.fixed32, true);
          snrDb = Number(tmp.getFloat32(0, true).toFixed(1));
        }

        let battPct: number | undefined;
        if (metricsField?.bytes) {
          const mf = parseProtobufFields(metricsField.bytes);
          const bField = mf.find((f) => f.fieldNumber === 1 && f.varint !== undefined);
          if (bField?.varint !== undefined) battPct = Math.min(100, bField.varint);
        }

        let posFix: HardwareGpsFix | null = null;
        if (posField?.bytes) {
          posFix = tryExtractPositionFromProtobuf(posField.bytes);
        }

        const lastHeardDate =
          lastHeardField?.fixed32 && lastHeardField.fixed32 > 1600000000
            ? new Date(lastHeardField.fixed32 * 1000)
            : new Date();

        if (nodeHexId) {
          this.upsertNode(nodeHexId, {
            nodeNum: numField?.varint,
            longName: longName || `Meshtastic ${nodeHexId.slice(-4)}`,
            shortName: shortName || nodeHexId.slice(-4).toUpperCase(),
            snr: snrDb,
            batteryLevel: battPct,
            hopsAway: hopsField?.varint,
            latitude: posFix?.latitude,
            longitude: posFix?.longitude,
            lastHeard: lastHeardDate,
          });
        }
      }

      // Field 5 (tag 0x2a): Config (specifically field 6 = LoRaConfig)
      if (field.fieldNumber === 5 && field.bytes) {
        const cf = parseProtobufFields(field.bytes);
        const loraField = cf.find((f) => f.fieldNumber === 6 && f.bytes !== undefined);
        if (loraField?.bytes) {
          const lf = parseProtobufFields(loraField.bytes);
          const usePreset = lf.find((f) => f.fieldNumber === 1)?.varint === 1;
          const presetCode = lf.find((f) => f.fieldNumber === 2)?.varint ?? 0;
          const regionCode = lf.find((f) => f.fieldNumber === 7)?.varint ?? 0;
          const hopLimit = lf.find((f) => f.fieldNumber === 8)?.varint ?? 3;
          const txEnabledField = lf.find((f) => f.fieldNumber === 9);
          // In proto3, verify if tx_enabled is explicitly present; Meshtastic defaults tx_enabled=true once region is set
          const txEnabled = txEnabledField ? txEnabledField.varint === 1 : regionCode !== 0;
          const txPower = lf.find((f) => f.fieldNumber === 10)?.varint ?? 0;
          const channelNum = lf.find((f) => f.fieldNumber === 11)?.varint ?? 0;
          const overrideFreqField = lf.find((f) => f.fieldNumber === 12);
          let overrideFreq: number | undefined;
          if (overrideFreqField?.fixed32 !== undefined) {
            const tmp = new DataView(new ArrayBuffer(4));
            tmp.setUint32(0, overrideFreqField.fixed32, true);
            overrideFreq = Number(tmp.getFloat32(0, true).toFixed(3));
          }

          this.diagnostics.usePreset = usePreset;
          this.diagnostics.modemPresetCode = presetCode;
          this.diagnostics.modemPresetName =
            MODEM_PRESET_NAMES[presetCode] || `CUSTOM_PRESET (${presetCode})`;
          this.diagnostics.regionCode = regionCode;
          this.diagnostics.regionName =
            REGION_CODE_NAMES[regionCode] || `REGION_${regionCode}`;
          this.diagnostics.hopLimit = hopLimit;
          this.diagnostics.txEnabled = txEnabled;
          this.diagnostics.txPowerDbm = txPower;
          this.diagnostics.frequencySlot = channelNum;
          this.diagnostics.overrideFrequencyMhz = overrideFreq;
          this.emitDiagnostics();
        }
      }

      // Field 6 (tag 0x32): LogRecord
      if (field.fieldNumber === 6 && field.bytes) {
        const logFields = parseProtobufFields(field.bytes);
        const msgField = logFields.find((f) => f.fieldNumber === 1 && f.bytes);
        if (msgField?.bytes) {
          this.diagnostics.lastRadioLogLine = decoder.decode(msgField.bytes).trim();
          this.emitDiagnostics();
        }
      }

      // Field 7 (tag 0x38): config_complete_id
      if (field.fieldNumber === 7 && field.varint !== undefined) {
        this.diagnostics.configCompleteCount += 1;
        this.emitDiagnostics();
      }

      // Field 10 (tag 0x52): Channel
      if (field.fieldNumber === 10 && field.bytes) {
        const chFields = parseProtobufFields(field.bytes);
        const idx = chFields.find((f) => f.fieldNumber === 1)?.varint ?? 0;
        const role = chFields.find((f) => f.fieldNumber === 3)?.varint ?? 0;
        const settingsField = chFields.find((f) => f.fieldNumber === 2 && f.bytes);

        // Role 1 = PRIMARY (or index 0 with role PRIMARY)
        if (idx === 0 || role === 1) {
          let chName = '';
          let pskHex = '01 (Default Public Key AQ==)';
          if (settingsField?.bytes) {
            const sf = parseProtobufFields(settingsField.bytes);
            const pskField = sf.find((f) => f.fieldNumber === 2 && f.bytes);
            const nameField = sf.find((f) => f.fieldNumber === 3 && f.bytes);
            if (nameField?.bytes) {
              chName = decoder.decode(nameField.bytes).trim();
            }
            if (pskField?.bytes) {
              const rawHex = bytesToHex(pskField.bytes);
              if (rawHex === '01') {
                pskHex = '01 (Default Public Key AQ==)';
              } else if (rawHex === '00' || rawHex === '') {
                pskHex = '00 (Unencrypted / No Key)';
              } else {
                pskHex = `${rawHex.slice(0, 12)}... (${pskField.bytes.length}B Custom Key)`;
              }
            }
          }
          this.diagnostics.primaryChannelName = chName || '(Default / Blank)';
          this.diagnostics.primaryChannelPskHex = pskHex;
          this.diagnostics.primaryChannelRole =
            role === 1 ? 'PRIMARY' : role === 2 ? 'SECONDARY' : 'DISABLED';
          this.emitDiagnostics();
        }
      }

      // Field 11 (tag 0x5a): QueueStatus
      if (field.fieldNumber === 11 && field.bytes) {
        const qf = parseProtobufFields(field.bytes);
        const res = qf.find((f) => f.fieldNumber === 1)?.varint ?? 0;
        const free = qf.find((f) => f.fieldNumber === 2)?.varint;
        const maxlen = qf.find((f) => f.fieldNumber === 3)?.varint;
        const meshPktId = qf.find((f) => f.fieldNumber === 4)?.varint;

        if (free !== undefined) this.diagnostics.queueFree = free;
        if (maxlen !== undefined) this.diagnostics.queueMax = maxlen;

        if (meshPktId) {
          this.updatePacketAckState(
            meshPktId,
            res === 0 ? 'tx_queued' : 'failed',
            res === 0
              ? `Queued in SX1262 LoRa buffer (${free ?? '?'}/${maxlen ?? '?'} free)`
              : `Radio TX Queue rejected packet (code ${res})`
          );
        }
        this.emitDiagnostics();
      }

      // Field 13 (tag 0x6a): DeviceMetadata
      if (field.fieldNumber === 13 && field.bytes) {
        const mf = parseProtobufFields(field.bytes);
        const fwField = mf.find((f) => f.fieldNumber === 1 && f.bytes);
        const hwField = mf.find((f) => f.fieldNumber === 9 && f.varint !== undefined);
        if (fwField?.bytes) {
          this.diagnostics.firmwareVersion = decoder.decode(fwField.bytes).trim();
        }
        if (hwField?.varint !== undefined) {
          this.diagnostics.hwModelId = hwField.varint;
        }
        this.emitDiagnostics();
      }

      // Field 2 (tag 0x12): MeshPacket
      if (field.fieldNumber === 2 && field.bytes) {
        this.handleIncomingMeshPacket(field.bytes, decoder);
      }
    }
  }

  private handleIncomingMeshPacket(meshPacketBytes: Uint8Array, decoder: TextDecoder) {
    const mpFields = parseProtobufFields(meshPacketBytes);
    const fromNum = mpFields.find((f) => f.fieldNumber === 1)?.fixed32;
    const decodedField = mpFields.find((f) => f.fieldNumber === 4 && f.bytes);
    const snrFixed = mpFields.find((f) => f.fieldNumber === 8)?.fixed32;
    const rssiVarint = mpFields.find((f) => f.fieldNumber === 11)?.varint;

    const senderHex =
      fromNum && fromNum !== 0xffffffff
        ? `!${fromNum.toString(16).padStart(8, '0').toLowerCase()}`
        : undefined;

    let rxSnr: number | undefined;
    if (snrFixed !== undefined) {
      const tmp = new DataView(new ArrayBuffer(4));
      tmp.setUint32(0, snrFixed, true);
      rxSnr = Number(tmp.getFloat32(0, true).toFixed(1));
    }

    let rxRssi: number | undefined;
    if (rssiVarint !== undefined) {
      // Signed int32 varint
      rxRssi = rssiVarint | 0;
    }

    if (senderHex && this.localIdentity?.nodeHexId !== senderHex) {
      this.upsertNode(senderHex, {
        nodeNum: fromNum,
        snr: rxSnr,
        rssi: rxRssi,
        lastHeard: new Date(),
      });
    }

    if (!decodedField?.bytes) return;

    const dataFields = parseProtobufFields(decodedField.bytes);
    const portnum = dataFields.find((f) => f.fieldNumber === 1)?.varint ?? 0;
    const payloadBytes = dataFields.find((f) => f.fieldNumber === 2 && f.bytes)?.bytes;
    const requestId = dataFields.find((f) => f.fieldNumber === 6)?.fixed32;

    // PORTNUM 1: TEXT_MESSAGE_APP
    if (portnum === 1 && payloadBytes) {
      if (this.localIdentity && senderHex === this.localIdentity.nodeHexId) {
        return;
      }
      const text = decoder.decode(payloadBytes).replace(/\x07/g, '').trim();
      if (text) {
        this.recordAndEmitPacket({
          id: `rx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          sender: senderHex || 'PEER_RADIO',
          payload: text,
          timestamp: new Date(),
          rssiDbm: rxRssi,
          snrDb: rxSnr,
          direction: 'rx',
        });
      }
    }

    // PORTNUM 3: POSITION_APP
    if (portnum === 3 && payloadBytes) {
      const posFix = tryExtractPositionFromProtobuf(payloadBytes);
      if (posFix) {
        if (senderHex) posFix.sourceNode = senderHex;
        this.emitGpsFix(posFix);
        if (senderHex) {
          this.upsertNode(senderHex, {
            latitude: posFix.latitude,
            longitude: posFix.longitude,
            snr: rxSnr,
            rssi: rxRssi,
          });
        }
      }
    }

    // PORTNUM 4: NODEINFO_APP (Peer broadcast of User info over LoRa!)
    if (portnum === 4 && payloadBytes && senderHex) {
      const uf = parseProtobufFields(payloadBytes);
      const longStr = uf.find((f) => f.fieldNumber === 2 && f.bytes);
      const shortStr = uf.find((f) => f.fieldNumber === 3 && f.bytes);
      this.upsertNode(senderHex, {
        nodeNum: fromNum,
        longName: longStr?.bytes ? decoder.decode(longStr.bytes).trim() : undefined,
        shortName: shortStr?.bytes ? decoder.decode(shortStr.bytes).trim() : undefined,
        snr: rxSnr,
        rssi: rxRssi,
      });
    }

    // PORTNUM 5: ROUTING_APP (Hardware ACK / NAK delivery confirmation!)
    if (portnum === 5 && payloadBytes) {
      const rf = parseProtobufFields(payloadBytes);
      const errorReason = rf.find((f) => f.fieldNumber === 3)?.varint ?? 0;
      const reasonText =
        ROUTING_ERROR_NAMES[errorReason] || `ROUTING_STATUS_CODE_${errorReason}`;

      const fromLabel =
        senderHex && senderHex !== this.localIdentity?.nodeHexId
          ? `from peer ${senderHex} (${rxSnr !== undefined ? `SNR ${rxSnr}dB` : 'RF link'})`
          : 'from local radio router';

      this.diagnostics.lastRoutingStatus = `${reasonText} [${fromLabel}]`;
      if (requestId) {
        this.updatePacketAckState(
          requestId,
          errorReason === 0 ? 'ack_received' : 'failed',
          `${reasonText} (${fromLabel})`
        );
      }
      this.emitDiagnostics();
    }

    // PORTNUM 256: PRIVATE_APP (32-Byte MeshMule Binary Sensor & Ephemeris Frame)
    if (portnum === 256 && payloadBytes && payloadBytes.length === 32) {
      try {
        const res = muleCollectorService.ingestRawMuleFrame(
          payloadBytes,
          senderHex || 'PEER_RADIO',
          Date.now()
        );
        const hexStr = muleBytesToHex(payloadBytes);
        this.recordAndEmitPacket({
          id: `rx_mule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          sender: senderHex || 'PEER_RADIO',
          payload: `MULE1:${hexStr} [${res.kind}:${res.dedupKey}|MAC:${res.macVerified ? 'OK' : 'FAIL'}]`,
          timestamp: new Date(),
          rssiDbm: rxRssi,
          snrDb: rxSnr,
          direction: 'rx',
        });
      } catch {
        // Ignore non-MeshMule private port traffic
      }
    }
  }

  private updatePacketAckState(meshPacketId: number, state: DeliveryAckState, detail: string) {
    let changed = false;
    for (const pkt of this.packetRing) {
      if (pkt.meshPacketId === meshPacketId) {
        pkt.ackState = state;
        pkt.ackDetail = detail;
        changed = true;
      }
    }
    if (changed) {
      for (const listener of this.packetListeners) {
        if (this.packetRing[0]) listener(this.packetRing[0]);
      }
    }
  }

  private recordAndEmitPacket(packet: RadioPacket) {
    if (packet.rssiDbm !== undefined && packet.rssi === undefined) {
      packet.rssi = packet.rssiDbm;
    } else if (packet.rssi !== undefined && packet.rssiDbm === undefined) {
      packet.rssiDbm = packet.rssi;
    }

    // Check for 32-Byte MeshMule Binary Hex Envelope (`MULE1:<64-char-hex>`)
    const muleMatch = packet.payload.match(/MULE1:([0-9A-Fa-f]{64})/);
    if (muleMatch && packet.direction === 'rx') {
      try {
        muleCollectorService.ingestRawMuleFrame(
          muleMatch[1],
          packet.sender || 'PEER_RADIO',
          packet.timestamp.getTime()
        );
      } catch {
        // Ignore malformed hex
      }
    }

    let parsedLat: number | undefined;
    let parsedLng: number | undefined;
    const wptMatch = packet.payload.match(/WPT:([0-9.]+)([NS]),([0-9.]+)([EW])/i);
    if (wptMatch && packet.direction === 'rx') {
      const lat = parseFloat(wptMatch[1]) * (wptMatch[2].toUpperCase() === 'S' ? -1 : 1);
      const lng = parseFloat(wptMatch[3]) * (wptMatch[4].toUpperCase() === 'W' ? -1 : 1);
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
        parsedLat = lat;
        parsedLng = lng;
        const fix: HardwareGpsFix = {
          latitude: lat,
          longitude: lng,
          updatedAt: new Date(),
          sourceNode: packet.sender,
        };
        packet.gpsFix = fix;
        this.emitGpsFix(fix);
      }
    }

    const battMatch = packet.payload.match(/BATT:(\d+)%/i);
    const parsedBatt = battMatch ? parseInt(battMatch[1], 10) : undefined;

    if (packet.direction === 'rx') {
      this.upsertNode(packet.sender, {
        batteryLevel: parsedBatt,
        snr: packet.snrDb,
        rssi: packet.rssiDbm,
        latitude: parsedLat,
        longitude: parsedLng,
      });
    }

    this.packetRing.unshift(packet);
    if (this.packetRing.length > RING_BUFFER_CAPACITY) {
      this.packetRing.length = RING_BUFFER_CAPACITY;
    }
    for (const listener of this.packetListeners) {
      listener(packet);
    }
  }

  /**
   * Safe BLE characteristic write with automatic MTU chunking and writeValueWithResponse negotiation.
   * If payload exceeds active ATT MTU, safely fragments into 20-byte chunks with paced yields.
   */
  private async writeBleCharacteristic(char: any, data: Uint8Array): Promise<void> {
    if (!char) throw new Error('BLE Characteristic is not initialized.');

    try {
      if (typeof char.writeValueWithResponse === 'function') {
        await char.writeValueWithResponse(data);
        return;
      }
      if (typeof char.writeValue === 'function') {
        await char.writeValue(data);
        return;
      }
    } catch (err: any) {
      const errMsg = err?.message || '';
      const isSizeError = /length|size|mtu|buffer|attribute/i.test(errMsg);
      if (!isSizeError && data.length <= 20) {
        throw err;
      }
    }

    // Fragmented fallback: 20-byte chunks matching baseline BLE ATT MTU
    const CHUNK_SIZE = 20;
    for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
      const chunk = data.slice(offset, Math.min(data.length, offset + CHUNK_SIZE));
      if (typeof char.writeValueWithResponse === 'function') {
        await char.writeValueWithResponse(chunk);
      } else if (typeof char.writeValue === 'function') {
        await char.writeValue(chunk);
      } else if (typeof char.writeValueWithoutResponse === 'function') {
        await char.writeValueWithoutResponse(chunk);
      }
      if (offset + CHUNK_SIZE < data.length) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }

  public getSignalQuality(): {
    rssiDbm: number | null;
    snrDb: number | null;
    qualityPct: number;
    rating: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'DISCONNECTED';
  } {
    if (this.connectionStatus === 'disconnected') {
      return { rssiDbm: null, snrDb: null, qualityPct: 0, rating: 'DISCONNECTED' };
    }

    const latestWithRf = this.packetRing.find(
      (p) => p.rssiDbm !== undefined || p.snrDb !== undefined
    );
    const rssi = latestWithRf?.rssiDbm ?? null;
    const snr = latestWithRf?.snrDb ?? null;

    if (rssi === null && snr === null) {
      return { rssiDbm: null, snrDb: null, qualityPct: 100, rating: 'EXCELLENT' };
    }

    let quality = 50;
    if (rssi !== null) {
      quality = Math.max(5, Math.min(100, Math.round(((rssi + 120) / 70) * 100)));
    }

    let rating: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' = 'FAIR';
    if (quality >= 80) rating = 'EXCELLENT';
    else if (quality >= 60) rating = 'GOOD';
    else if (quality >= 35) rating = 'FAIR';
    else rating = 'POOR';

    return { rssiDbm: rssi, snrDb: snr, qualityPct: quality, rating };
  }

  public async connectBluetooth(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !('bluetooth' in navigator)) {
      throw new Error('Web Bluetooth is not supported in this browser. Use Chrome or Edge, or connect via USB-C cable.');
    }

    await this.disconnect();

    // @ts-ignore
    const device = await navigator.bluetooth.requestDevice({
      filters: [
        { services: [MESHTASTIC_SERVICE_UUID] },
        { services: [ALT_BLE_SERVICE_UUID] },
        { services: [NUS_SERVICE_UUID] },
        { namePrefix: 'Meshtastic' },
        { namePrefix: 'Heltec' },
        { namePrefix: 'T-Beam' },
        { namePrefix: 'T-Echo' },
        { namePrefix: 'T-Deck' },
        { namePrefix: 'RAK' },
        { namePrefix: 'SenseCAP' },
        { namePrefix: 'T1000' },
        { namePrefix: 'Wio' },
        { namePrefix: 'Meshnology' },
        { namePrefix: 'W10' },
        { namePrefix: 'LilyGO' },
      ],
      optionalServices: [MESHTASTIC_SERVICE_UUID, ALT_BLE_SERVICE_UUID, NUS_SERVICE_UUID, 'battery_service'],
    });

    this.bleDevice = device;
    device.addEventListener('gattserverdisconnected', () => {
      this.setLocalIdentity(null);
      this.setStatus('disconnected', 'No Radio Connected');
    });

    this.bleServer = await device.gatt.connect();

    try {
      const service = await this.bleServer.getPrimaryService(MESHTASTIC_SERVICE_UUID);
      this.bleToRadioChar = await service.getCharacteristic(TORADIO_CHAR_UUID);
      this.bleFromRadioChar = await service.getCharacteristic(FROMRADIO_CHAR_UUID);
      this.bleFromNumChar = await service.getCharacteristic(FROMNUM_CHAR_UUID);
      this.isBleUartFallback = false;

      const wantConfig = buildMeshtasticWantConfigPacket(Math.floor(Math.random() * 90000) + 10000);
      await this.writeBleCharacteristic(this.bleToRadioChar, wantConfig);

      await this.bleFromNumChar.startNotifications();
      this.bleFromNumChar.addEventListener('characteristicvaluechanged', async () => {
        await this.drainBleFromRadio();
      });
      await this.drainBleFromRadio();
    } catch {
      try {
        const altService = await this.bleServer.getPrimaryService(ALT_BLE_SERVICE_UUID);
        this.bleToRadioChar = await altService.getCharacteristic(ALT_TORADIO_UUID);
        this.bleFromRadioChar = await altService.getCharacteristic(ALT_FROMRADIO_UUID);
        try {
          this.bleFromNumChar = await altService.getCharacteristic(ALT_FROMNUM_UUID);
          this.isBleUartFallback = false;
          const wantConfig = buildMeshtasticWantConfigPacket(Math.floor(Math.random() * 90000) + 10000);
          await this.writeBleCharacteristic(this.bleToRadioChar, wantConfig);
          await this.bleFromNumChar.startNotifications();
          this.bleFromNumChar.addEventListener('characteristicvaluechanged', async () => {
            await this.drainBleFromRadio();
          });
          await this.drainBleFromRadio();
        } catch {
          this.isBleUartFallback = true;
          await this.bleFromRadioChar.startNotifications();
          this.bleFromRadioChar.addEventListener('characteristicvaluechanged', (event: any) => {
            const val: DataView = event.target.value;
            if (!val) return;
            const bytes = new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
            this.handleIncomingFromRadioBytes(bytes);
          });
        }
      } catch {
        const nusService = await this.bleServer.getPrimaryService(NUS_SERVICE_UUID);
        this.bleToRadioChar = await nusService.getCharacteristic(NUS_TX_CHAR_UUID);
        const rxChar = await nusService.getCharacteristic(NUS_RX_CHAR_UUID);
        this.isBleUartFallback = true;

        await rxChar.startNotifications();
        rxChar.addEventListener('characteristicvaluechanged', (event: any) => {
          const val: DataView = event.target.value;
          const bytes = new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
          const text = new TextDecoder().decode(bytes).trim();
          if (text) {
            this.recordAndEmitPacket({
              id: `rx_ble_${Date.now()}`,
              sender: device.name || 'BLE_Peer',
              payload: text,
              timestamp: new Date(),
              direction: 'rx',
            });
          }
        });
      }
    }

    this.setStatus('bluetooth', device.name || 'Meshtastic BLE Radio');
    return true;
  }

  private async drainBleFromRadio(): Promise<void> {
    if (!this.bleFromRadioChar) return;
    try {
      for (let i = 0; i < 40; i++) {
        const val: DataView = await this.bleFromRadioChar.readValue();
        if (!val || val.byteLength === 0) break;
        const bytes = new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
        this.handleIncomingFromRadioBytes(bytes);
      }
    } catch {
      // Queue drained
    }
  }

  public async connectSerial(baudRate: number = 115200): Promise<boolean> {
    if (typeof navigator === 'undefined' || !('serial' in navigator)) {
      throw new Error('Web Serial is not supported in this browser. Use Chrome or Edge on your laptop.');
    }

    await this.disconnect();

    // @ts-ignore
    const port = await navigator.serial.requestPort({});

    await port.open({ baudRate });

    try {
      await port.setSignals({ dataTerminalReady: true, requestToSend: false });
    } catch {
      // Ignore if USB driver does not expose DTR/RTS
    }

    this.serialPort = port;
    this.serialKeepReading = true;
    this.discoveredNodes.clear();

    this.setStatus('serial', `USB-C Radio (${baudRate} baud)`);
    this.readSerialLoop();

    // Wait 80ms for ESP32-S3 USB CDC endpoint to settle, then send 32-byte 0xC3 wake preamble + want_config_id
    setTimeout(() => {
      this.requestDiagnosticsRefresh().catch(() => {});
    }, 80);

    // Retry once at 1200ms if MyNodeInfo hasn't arrived yet
    setTimeout(() => {
      if (this.connectionStatus === 'serial' && !this.localIdentity) {
        this.requestDiagnosticsRefresh().catch(() => {});
      }
    }, 1200);

    return true;
  }

  /**
   * Sends the 32-byte 0xC3 Meshtastic StreamAPI wakeup preamble followed by a fresh
   * `ToRadio { want_config_id }` request so the connected radio dumps its full
   * MyNodeInfo, LoRaConfig, Channels, and NodeDB.
   */
  public async requestDiagnosticsRefresh(): Promise<void> {
    const randomConfigId = Math.floor(Math.random() * 89999) + 10000;
    const wantConfigProto = buildMeshtasticWantConfigPacket(randomConfigId);

    if (this.connectionStatus === 'serial' && this.serialPort && this.serialPort.writable) {
      const writer = this.serialPort.writable.getWriter();
      try {
        // 32-byte 0xC3 preamble wakes & resets the Meshtastic serial state machine
        const preamble = new Uint8Array(32).fill(MESH_START2);
        await writer.write(preamble);
        const wakeFrame = wrapMeshtasticSerialFrame(wantConfigProto);
        await writer.write(wakeFrame);
      } finally {
        writer.releaseLock();
      }
      return;
    }

    if (this.connectionStatus === 'bluetooth' && this.bleToRadioChar && !this.isBleUartFallback) {
      await this.writeBleCharacteristic(this.bleToRadioChar, wantConfigProto);
      await this.drainBleFromRadio();
      return;
    }

    if (this.connectionStatus === 'wifi') {
      await fetch(`http://${this.wifiHost}/api/v1/toradio`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/x-protobuf' },
        body: wantConfigProto as unknown as BodyInit,
        mode: 'no-cors',
      });
    }
  }

  /**
   * Writes a clean, standardized US 915 MHz LoRa & Primary Channel 0 configuration
   * directly to the connected radio over USB-C / BLE using `ADMIN_APP` (`portnum = 6`).
   * Ensures both radios share the exact same Region (US), ModemPreset, Frequency Slot (0 = auto),
   * TX Enabled (true), Primary Channel Name (""), and Default Public Key (0x01 / AQ==).
   */
  public async applyStandardMeshConfig(preset: 'LONG_TURBO' | 'LONG_FAST'): Promise<void> {
    if (this.connectionStatus === 'disconnected') {
      throw new Error('Connect a radio via USB-C first before applying configuration.');
    }
    const targetNodeNum = this.localIdentity?.nodeNum;
    if (!targetNodeNum) {
      await this.requestDiagnosticsRefresh();
      throw new Error('Waiting for radio Node ID handshake. Click "Refresh Radio Diagnostics" first.');
    }

    const presetCode = preset === 'LONG_TURBO' ? 9 : 0;

    // 1. AdminMessage: begin_edit_settings = 64 (tag: (64 << 3) | 0 = 512 -> 0x80, 0x04, value: 0x01)
    const beginEditAdmin = [0x80, 0x04, 0x01];

    // 2. AdminMessage: set_channel = 33 (tag: (33 << 3) | 2 = 266 -> 0x8a, 0x02)
    // Channel 0: index=0, settings={ psk=[0x01], name="" }, role=1 (PRIMARY)
    const channelSettingsBytes = [
      0x12, 0x01, 0x01, // field 2: psk = [0x01] (Default AQ==)
      0x1a, 0x00,       // field 3: name = "" (Default)
    ];
    const channel0Bytes = [
      0x08, 0x00, // field 1: index = 0
      0x12, ...encodeVarint(channelSettingsBytes.length), ...channelSettingsBytes,
      0x18, 0x01, // field 3: role = 1 (PRIMARY)
    ];
    const setChannelAdmin = [
      0x8a, 0x02, ...encodeVarint(channel0Bytes.length), ...channel0Bytes,
    ];

    // 3. AdminMessage: set_config = 34 (tag: (34 << 3) | 2 = 274 -> 0x92, 0x02)
    // Config { lora (field 6, tag 0x32): LoRaConfig { use_preset=true, modem_preset=presetCode, region=1 (US), hop_limit=3, tx_enabled=true, channel_num=0 } }
    const loraConfigBytes: number[] = [
      0x08, 0x01, // field 1: use_preset = true
    ];
    if (presetCode > 0) {
      loraConfigBytes.push(0x10, ...encodeVarint(presetCode)); // field 2: modem_preset
    }
    loraConfigBytes.push(
      0x38, 0x01, // field 7: region = 1 (US 915MHz)
      0x40, 0x03, // field 8: hop_limit = 3
      0x48, 0x01  // field 9: tx_enabled = true
    );
    const configBytes = [
      0x32, ...encodeVarint(loraConfigBytes.length), ...loraConfigBytes,
    ];
    const setConfigAdmin = [
      0x92, 0x02, ...encodeVarint(configBytes.length), ...configBytes,
    ];

    // 4. AdminMessage: commit_edit_settings = 65 (tag: (65 << 3) | 0 = 520 -> 0x88, 0x04, value: 0x01)
    const commitEditAdmin = [0x88, 0x04, 0x01];

    const packets = [
      buildLocalAdminToRadioPacket(targetNodeNum, beginEditAdmin),
      buildLocalAdminToRadioPacket(targetNodeNum, setChannelAdmin),
      buildLocalAdminToRadioPacket(targetNodeNum, setConfigAdmin),
      buildLocalAdminToRadioPacket(targetNodeNum, commitEditAdmin),
    ];

    if (this.connectionStatus === 'serial' && this.serialPort?.writable) {
      const writer = this.serialPort.writable.getWriter();
      try {
        for (const pkt of packets) {
          await writer.write(wrapMeshtasticSerialFrame(pkt));
          await new Promise((r) => setTimeout(r, 120));
        }
      } finally {
        writer.releaseLock();
      }
      this.diagnostics.lastRoutingStatus = `Sent US + ${preset} + Default Channel 0 config to _${this.localIdentity?.shortSuffix}. Radio may reboot to apply.`;
      this.emitDiagnostics();
      setTimeout(() => {
        this.requestDiagnosticsRefresh().catch(() => {});
      }, 1500);
      return;
    }

    if (this.connectionStatus === 'bluetooth' && this.bleToRadioChar) {
      for (const pkt of packets) {
        await this.writeBleCharacteristic(this.bleToRadioChar, pkt);
        await new Promise((r) => setTimeout(r, 140));
      }
      this.diagnostics.lastRoutingStatus = `Sent US + ${preset} config over BLE to _${this.localIdentity?.shortSuffix}. Radio applying settings...`;
      this.emitDiagnostics();
      setTimeout(() => {
        this.requestDiagnosticsRefresh().catch(() => {});
      }, 1500);
      return;
    }
  }

  /**
   * One-click unblocker: Forces Region = US (1: 902–928 MHz), TX Enabled = true, and hop_limit = 3
   * so an unconfigured or factory-reset radio can transmit on LoRa immediately.
   */
  public async unlockUsTxRegion(modemPreset: 'LONG_FAST' | 'LONG_TURBO' = 'LONG_FAST'): Promise<void> {
    await this.applyStandardMeshConfig(modemPreset);
  }

  private async readSerialLoop(): Promise<void> {
    if (!this.serialPort || !this.serialPort.readable) return;

    const decoder = new TextDecoder();
    let textLineBuffer = '';
    let binaryBuffer = new Uint8Array(0);

    try {
      this.serialReader = this.serialPort.readable.getReader();
      while (this.serialKeepReading) {
        const { value, done } = await this.serialReader.read();
        if (done) break;
        if (!value || value.length === 0) continue;

        const chunk: Uint8Array = value;

        // 1. Parse Meshtastic 0x94 0xC3 framed protobuf packets
        const merged = new Uint8Array(binaryBuffer.length + chunk.length);
        merged.set(binaryBuffer, 0);
        merged.set(chunk, binaryBuffer.length);
        binaryBuffer = merged;

        let scanIdx = 0;
        let lastConsumedEnd = 0;
        while (scanIdx <= binaryBuffer.length - 4) {
          if (binaryBuffer[scanIdx] === MESH_START1 && binaryBuffer[scanIdx + 1] === MESH_START2) {
            const frameLen = (binaryBuffer[scanIdx + 2] << 8) | binaryBuffer[scanIdx + 3];
            if (frameLen > 0 && frameLen <= 512) {
              if (scanIdx + 4 + frameLen <= binaryBuffer.length) {
                const protoBytes = binaryBuffer.slice(scanIdx + 4, scanIdx + 4 + frameLen);
                this.diagnostics.framesRxCount += 1;
                this.handleIncomingFromRadioBytes(protoBytes);
                scanIdx += 4 + frameLen;
                lastConsumedEnd = scanIdx;
                continue;
              } else {
                // Valid header found, waiting for remaining bytes in next USB chunk
                lastConsumedEnd = scanIdx;
                break;
              }
            }
          }
          scanIdx += 1;
        }

        if (lastConsumedEnd > 0) {
          binaryBuffer = binaryBuffer.slice(lastConsumedEnd);
        } else if (binaryBuffer.length > 4096) {
          binaryBuffer = binaryBuffer.slice(binaryBuffer.length - 512);
        }

        // 2. Parse newline-delimited ASCII frames (debug console logs or raw TEXTMSG mode)
        textLineBuffer += decoder.decode(chunk, { stream: true });
        const lines = textLineBuffer.split(/\r?\n/);
        textLineBuffer = lines.pop() || '';

        for (const rawLine of lines) {
          const clean = rawLine.replace(/\x1b\[[0-9;]*m/g, '').replace(/[^\x20-\x7E]/g, '').trim();
          if (!clean) continue;

          // Capture diagnostic radio serial log lines (e.g. LoRa init, freq, SNR, errors)
          if (
            clean.length >= 8 &&
            /(?:INFO|DEBUG|WARN|ERROR|Radio|SX126|Lora|freq|slot|NodeNum|Packet)/i.test(clean)
          ) {
            this.diagnostics.lastRadioLogLine = clean.slice(0, 140);
            this.emitDiagnostics();
          }

          if (
            clean.length >= 4 &&
            (/(?:BATT|TEMP|WPT|FLOW|SOL|COND|MSG|ERR):/.test(clean) || this.framingMode === 'raw_serial')
          ) {
            this.recordAndEmitPacket({
              id: `rx_txt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              sender: 'SERIAL_RX',
              payload: clean,
              timestamp: new Date(),
              direction: 'rx',
            });
          }
        }
      }
    } catch {
      // Port closed or unplugged
    } finally {
      if (this.serialReader) {
        try {
          this.serialReader.releaseLock();
        } catch {
          // Ignore
        }
        this.serialReader = null;
      }
    }
  }

  public async connectWifi(hostOverride?: string): Promise<boolean> {
    await this.disconnect();
    if (hostOverride) {
      this.setWifiHost(hostOverride);
    }

    const endpoint = `http://${this.wifiHost}/api/v1/toradio`;
    const wakeProto = buildMeshtasticWantConfigPacket();

    try {
      await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/x-protobuf' },
        body: wakeProto as unknown as BodyInit,
        mode: 'no-cors',
      });
    } catch {
      throw new Error(
        `Could not reach Meshtastic HTTP endpoint at http://${this.wifiHost}. Check that your radio is on the same Wi-Fi network.`
      );
    }

    this.setStatus('wifi', `Wi-Fi Node (${this.wifiHost})`);

    this.wifiPollTimer = setInterval(async () => {
      try {
        const res = await fetch(`http://${this.wifiHost}/api/v1/fromradio`, {
          method: 'GET',
          headers: { Accept: 'application/x-protobuf' },
        });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          if (buf.byteLength > 0) {
            const bytes = new Uint8Array(buf);
            this.handleIncomingFromRadioBytes(bytes);
          }
        }
      } catch {
        // Ignore transient poll errors
      }
    }, 1500);

    return true;
  }

  public async disconnect(): Promise<void> {
    this.serialKeepReading = false;

    if (this.wifiPollTimer) {
      clearInterval(this.wifiPollTimer);
      this.wifiPollTimer = null;
    }

    if (this.serialReader) {
      try {
        await this.serialReader.cancel();
      } catch {
        // Ignore
      }
      this.serialReader = null;
    }

    if (this.serialPort) {
      try {
        await this.serialPort.close();
      } catch {
        // Ignore
      }
      this.serialPort = null;
    }

    if (this.bleDevice && this.bleDevice.gatt && this.bleDevice.gatt.connected) {
      try {
        this.bleDevice.gatt.disconnect();
      } catch {
        // Ignore
      }
    }
    this.bleDevice = null;
    this.bleServer = null;
    this.bleToRadioChar = null;
    this.bleFromRadioChar = null;
    this.bleFromNumChar = null;
    this.setLocalIdentity(null);

    this.setStatus('disconnected', 'No Radio Connected');
  }

  public async sendRadioPayload(
    payloadText: string,
    channelIndex: number = 0,
    destinationNodeNum: number = 0xffffffff
  ): Promise<{ sent: boolean; packetId?: number }> {
    const clamped = clampToLoRaBudget(payloadText, MAX_LORA_FRAME_BYTES);
    if (!clamped) return { sent: false };

    if (this.connectionStatus === 'disconnected') {
      throw new Error('No radio connected. Connect your radio via USB-C cable, Bluetooth, or Wi-Fi first.');
    }

    const { protoBytes, packetId } = buildMeshtasticToRadioTextPacket(
      clamped,
      channelIndex,
      this.bellAlertEnabled,
      destinationNodeNum
    );

    if (this.connectionStatus === 'bluetooth') {
      if (!this.bleToRadioChar) {
        throw new Error('BLE ToRadio characteristic not initialized.');
      }
      if (this.isBleUartFallback || this.framingMode === 'raw_serial') {
        const prefix = this.bellAlertEnabled ? '\x07' : '';
        const bytes = new TextEncoder().encode(prefix + clamped + '\n');
        await this.writeBleCharacteristic(this.bleToRadioChar, bytes);
      } else {
        await this.writeBleCharacteristic(this.bleToRadioChar, protoBytes);
      }
      return { sent: true, packetId };
    }

    if (this.connectionStatus === 'serial') {
      if (!this.serialPort || !this.serialPort.writable) {
        throw new Error('USB Serial port is not writable.');
      }
      const writer = this.serialPort.writable.getWriter();
      try {
        if (this.framingMode === 'meshtastic_protobuf') {
          const framed = wrapMeshtasticSerialFrame(protoBytes);
          await writer.write(framed);
        } else {
          const prefix = this.bellAlertEnabled ? '\x07' : '';
          const rawBytes = new TextEncoder().encode(prefix + clamped + '\r\n');
          await writer.write(rawBytes);
        }
      } finally {
        writer.releaseLock();
      }
      return { sent: true, packetId };
    }

    if (this.connectionStatus === 'wifi') {
      await fetch(`http://${this.wifiHost}/api/v1/toradio`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/x-protobuf' },
        body: protoBytes as unknown as BodyInit,
        mode: 'no-cors',
      });
      return { sent: true, packetId };
    }

    return { sent: false };
  }

  /**
   * Broadcasts a 32-byte MeshMule binary frame (`0xA1` Sensor Harvest or `0xB2` Ridge-Mule Ephemeris)
   * over the 915 MHz LoRa mesh using compact `MULE1:<64-hex>` framing (compatible with all stock
   * Meshtastic repeaters and OLED screens) and logs it in the local transceiver ring buffer.
   */
  public async sendMuleBinaryFrame(
    frameBytes: Uint8Array,
    summaryLabel: string,
    channelIndex: number = 0
  ): Promise<{ sentOverRf: boolean; wirePayload: string; packetId?: number }> {
    const hex64 = muleBytesToHex(frameBytes);
    const wirePayload = `MULE1:${hex64} ${summaryLabel}`.slice(0, MAX_LORA_FRAME_BYTES);
    const localSender = this.localIdentity?.nodeHexId || 'LOCAL_MULE';

    if (this.connectionStatus !== 'disconnected') {
      const res = await this.sendRadioPayload(wirePayload, channelIndex);
      this.recordAndEmitPacket({
        id: `tx_mule_${Date.now()}`,
        meshPacketId: res.packetId,
        sender: localSender,
        payload: wirePayload,
        timestamp: new Date(),
        direction: 'tx',
        ackState: 'queued',
        ackDetail: '32B MeshMule frame sent to SX1262 LoRa transceiver',
      });
      return { sentOverRf: res.sent, wirePayload, packetId: res.packetId };
    }

    // When offline / pre-staging without a connected USB/BLE transceiver, log to local ring buffer & outbox
    this.recordAndEmitPacket({
      id: `stage_mule_${Date.now()}`,
      sender: localSender,
      payload: wirePayload,
      timestamp: new Date(),
      direction: 'tx',
      ackState: 'queued',
      ackDetail: 'Staged in IndexedDB Store-and-Forward Outbox (Connect USB/BLE Radio for 915 MHz RF TX)',
    });
    return { sentOverRf: false, wirePayload };
  }
}

export const meshtasticRadioService = new MeshtasticRadioService();
