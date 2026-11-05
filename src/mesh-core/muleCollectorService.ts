/**
 * MeshMule Core — Store-and-Forward Citizen-Science Collector & Outbox Engine
 *
 * Manages the complete lifecycle of 32-byte MeshMule binary telemetry frames:
 * - Persistent IndexedDB + localStorage offline store-and-forward queue (`mesh_mule_outbox_v1`)
 * - 4-byte SipHash-2-4 MAC verification & tamper rejection
 * - RTC clock-drift correction using relative sample age offsets
 * - Idempotent multi-mule witness deduplication (`stationCallsign:sequenceNumber`)
 * - Zero-identity privacy stripping (one-way anonymous contributor credit token)
 * - Automatic batch synchronization with the `/__telemetry/mule-collector` agency ingestion API
 * - Direct RFC 7946 GeoJSON and scientific CSV export for USGS / NPS / USFS / CDFW researchers
 *
 * License: MIT (Open-Source Grant Engine / BiteWindow Vector7 Dual-Core)
 */

import {
  DecodedRidgeMuleEphemerisFrame,
  DecodedSensorHarvestFrame,
  MuleSensorDomain,
  RidgeMuleEphemerisInput,
  SensorHarvestInput,
  bytesToHex,
  decodeAnyMuleFrame,
  decodeRidgeMuleEphemerisFrame,
  decodeSensorHarvestFrame,
  encodeRidgeMuleEphemerisFrame,
  encodeSensorHarvestFrame,
} from './muleCodec';

export interface StoredMuleHarvestEnvelope {
  dedupKey: string;
  rawHex: string;
  decoded: DecodedSensorHarvestFrame;
  firstHarvestedAtUtc: number;
  lastWitnessedAtUtc: number;
  witnessCount: number;
  witnessNodeHashes: string[];
  anonymousContributorToken: string;
  syncStatus: 'QUEUED_OFFLINE' | 'SYNCED_TO_COLLECTOR' | 'REJECTED_INVALID_MAC';
  syncedAtUtc?: number;
  collectorReceiptId?: string;
}

export interface StoredRidgeMuleEphemeris {
  dedupKey: string;
  rawHex: string;
  decoded: DecodedRidgeMuleEphemerisFrame;
  receivedAtUtc: number;
  sourceNodeId: string;
}

export interface CollectorGatewaySyncResponse {
  ok: boolean;
  ingestedCount: number;
  deduplicatedCount: number;
  rejectedMacCount: number;
  totalLedgerRecords: number;
  receiptId: string;
  records: StoredMuleHarvestEnvelope[];
}

const DB_NAME = 'mesh_mule_outbox_v1';
const DB_VERSION = 1;
const STORE_HARVESTS = 'sensor_harvests';
const STORE_EPHEMERIS = 'ridge_ephemeris';
const LS_HARVEST_MIRROR_KEY = 'bitewindow_meshmule_harvests_v1';
const LS_EPHEMERIS_MIRROR_KEY = 'bitewindow_meshmule_ephemeris_v1';
const LS_ANON_TOKEN_KEY = 'bitewindow_meshmule_anon_token_v1';

/**
 * Generates or retrieves a persistent, non-identifying 64-bit anonymous
 * citizen-science contributor token (`MULE-XXXX-XXXX`).
 */
export function getAnonymousContributorToken(): string {
  if (typeof window === 'undefined') {
    return 'MULE-SERVER-NODE';
  }
  try {
    const existing = window.localStorage.getItem(LS_ANON_TOKEN_KEY);
    if (existing && existing.startsWith('MULE-')) {
      return existing;
    }
    const rand = new Uint32Array(2);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(rand);
    } else {
      rand[0] = Math.floor(Math.random() * 0xffffffff);
      rand[1] = Math.floor(Math.random() * 0xffffffff);
    }
    const p1 = (rand[0] >>> 0).toString(16).toUpperCase().padStart(8, '0').slice(0, 4);
    const p2 = (rand[1] >>> 0).toString(16).toUpperCase().padStart(8, '0').slice(0, 4);
    const token = `MULE-${p1}-${p2}`;
    window.localStorage.setItem(LS_ANON_TOKEN_KEY, token);
    return token;
  } catch {
    return 'MULE-ANON-0001';
  }
}

/**
 * Hashes a Meshtastic node ID into an irreversible 6-char witness tag so
 * multi-mule witness counts can be audited without storing user hardware MACs.
 */
export function hashWitnessNodeId(nodeId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < nodeId.length; i++) {
    h ^= nodeId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 'W-' + (h >>> 0).toString(16).toUpperCase().padStart(6, '0').slice(0, 6);
}

/**
 * Pre-seeded real-world backcountry sensor stations (Yosemite NP, Merced River,
 * Tuolumne Alpine SNOTEL, USFS Sierra RAWS, CDFW Klamath Thermal Refugia) so
 * field operators can inspect and test 32-byte binary frames out of the box.
 */
const INITIAL_FIELD_HARVEST_SEEDS: SensorHarvestInput[] = [
  {
    stationCallsign: 'YOS-G1',
    sequenceNumber: 1402,
    domain: MuleSensorDomain.NPS_GEOTHERMAL_SEISMIC,
    batteryPercent: 94,
    solarCharging: true,
    tamperAlert: false,
    thresholdExceeded: false,
    relativeAgeSeconds: 420,
    lat: 37.7459,
    lon: -119.5332,
    elevationMeters: 1218,
    primaryValue: 64.8, // Hydrothermal vent temp C
    secondaryValue: 412, // Soil Radon / CO2 flux ppm
    tertiaryValue: 98.4, // Acoustic harmonic tremor RMS
    stepIntervalMinutes: 15,
    historicalPrimarySeries: [64.2, 64.3, 64.5, 64.6, 64.7, 64.8],
  },
  {
    stationCallsign: 'MRC-H4',
    sequenceNumber: 8891,
    domain: MuleSensorDomain.USGS_HYDRO_GAUGE,
    batteryPercent: 89,
    solarCharging: true,
    tamperAlert: false,
    thresholdExceeded: false,
    relativeAgeSeconds: 180,
    lat: 37.7167,
    lon: -119.6658,
    elevationMeters: 985,
    primaryValue: 11.4, // Water Temp C
    secondaryValue: 645, // Discharge CFS
    tertiaryValue: 10.6, // Dissolved Oxygen mg/L
    stepIntervalMinutes: 15,
    historicalPrimarySeries: [11.9, 11.8, 11.7, 11.6, 11.5, 11.4],
  },
  {
    stationCallsign: 'SNF-F9',
    sequenceNumber: 3110,
    domain: MuleSensorDomain.USFS_WILDFIRE_RAWS,
    batteryPercent: 78,
    solarCharging: false,
    tamperAlert: false,
    thresholdExceeded: true,
    relativeAgeSeconds: 900,
    lat: 37.5482,
    lon: -119.6391,
    elevationMeters: 1640,
    primaryValue: 28.4, // Ambient Canopy Air Temp C
    secondaryValue: 16, // Relative Humidity %
    tertiaryValue: 7.2, // 10-Hour Dead Fuel Moisture % (Critical <= 8%)
    stepIntervalMinutes: 30,
    historicalPrimarySeries: [25.8, 26.4, 27.0, 27.5, 28.0, 28.4],
  },
  {
    stationCallsign: 'KLM-R2',
    sequenceNumber: 5204,
    domain: MuleSensorDomain.CDFW_HABITAT_WATER_QUALITY,
    batteryPercent: 91,
    solarCharging: true,
    tamperAlert: false,
    thresholdExceeded: false,
    relativeAgeSeconds: 310,
    lat: 41.5236,
    lon: -123.5284,
    elevationMeters: 295,
    primaryValue: 13.2, // Thermal Refugia Pool Temp C
    secondaryValue: 38, // Specific Conductance uS/cm
    tertiaryValue: 9.8, // Dissolved Oxygen mg/L
    stepIntervalMinutes: 15,
    historicalPrimarySeries: [13.5, 13.4, 13.4, 13.3, 13.2, 13.2],
  },
];

class MuleCollectorService {
  private harvestMap: Map<string, StoredMuleHarvestEnvelope> = new Map();
  private ephemerisList: StoredRidgeMuleEphemeris[] = [];
  private listeners: Set<() => void> = new Set();
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private initialized = false;

  constructor() {
    this.initStorage();
  }

  private initStorage(): void {
    if (this.initialized) return;
    this.initialized = true;

    // 1. Load synchronous mirror from localStorage immediately
    if (typeof window !== 'undefined') {
      try {
        const rawHarvests = window.localStorage.getItem(LS_HARVEST_MIRROR_KEY);
        if (rawHarvests) {
          const parsed = JSON.parse(rawHarvests) as StoredMuleHarvestEnvelope[];
          for (const item of parsed) {
            if (item && item.dedupKey) {
              this.harvestMap.set(item.dedupKey, item);
            }
          }
        }
        const rawEphemeris = window.localStorage.getItem(LS_EPHEMERIS_MIRROR_KEY);
        if (rawEphemeris) {
          this.ephemerisList = JSON.parse(rawEphemeris) as StoredRidgeMuleEphemeris[];
        }
      } catch {
        // Ignore corrupt localStorage state
      }
    }

    // 2. Seed initial field stations if outbox is empty
    if (this.harvestMap.size === 0) {
      const now = Date.now();
      for (const seed of INITIAL_FIELD_HARVEST_SEEDS) {
        const frameBytes = encodeSensorHarvestFrame(seed);
        const decoded = decodeSensorHarvestFrame(frameBytes, now);
        const envelope: StoredMuleHarvestEnvelope = {
          dedupKey: decoded.dedupKey,
          rawHex: decoded.rawHex,
          decoded,
          firstHarvestedAtUtc: now - seed.relativeAgeSeconds * 1000,
          lastWitnessedAtUtc: now,
          witnessCount: 1,
          witnessNodeHashes: [hashWitnessNodeId('!seed0001')],
          anonymousContributorToken: getAnonymousContributorToken(),
          syncStatus: 'QUEUED_OFFLINE',
        };
        this.harvestMap.set(envelope.dedupKey, envelope);
      }
      this.saveLocalStorageMirror();
    }

    // 3. Seed an initial 0xB2 Ridge-Mule 24-Hour USGS Hydrograph frame if empty
    if (this.ephemerisList.length === 0) {
      const now = Date.now();
      const seedEphemerisInput: RidgeMuleEphemerisInput = {
        gaugeId: '11264500', // USGS Merced River at Happy Isles Bridge, Yosemite NP
        sequenceNumber: 408,
        waterTempC: 11.4,
        seaLevelPressureHpa: 1016.8,
        pressureDelta3hHpa: -2.1,
        biteWindowScore: 88,
        nwsAlertCode: 1,
        dischargeCfs24hSeries: [
          580, 585, 595, 610, 635, 660, 685, 690, 675, 660, 650, 645,
        ],
      };
      const ephemBytes = encodeRidgeMuleEphemerisFrame(seedEphemerisInput);
      const decodedEphem = decodeRidgeMuleEphemerisFrame(ephemBytes, now);
      this.ephemerisList.push({
        dedupKey: decodedEphem.dedupKey,
        rawHex: decodedEphem.rawHex,
        decoded: decodedEphem,
        receivedAtUtc: now,
        sourceNodeId: '!ridge915',
      });
      this.saveLocalStorageMirror();
    }

    // 4. Open IndexedDB asynchronously and hydrate any additional persisted frames
    if (typeof window !== 'undefined' && 'indexedDB' in window) {
      this.openIndexedDb().then((db) => {
        if (!db) return;
        this.hydrateFromIndexedDb(db);
      });

      window.addEventListener('online', () => {
        this.syncWithGateway().catch(() => {});
      });
    }
  }

  private openIndexedDb(): Promise<IDBDatabase | null> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve) => {
      try {
        const req = window.indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_HARVESTS)) {
            db.createObjectStore(STORE_HARVESTS, { keyPath: 'dedupKey' });
          }
          if (!db.objectStoreNames.contains(STORE_EPHEMERIS)) {
            db.createObjectStore(STORE_EPHEMERIS, { keyPath: 'dedupKey' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.dbPromise;
  }

  private hydrateFromIndexedDb(db: IDBDatabase): void {
    try {
      const tx = db.transaction([STORE_HARVESTS, STORE_EPHEMERIS], 'readonly');
      const harvestStore = tx.objectStore(STORE_HARVESTS);
      const getAllHarvests = harvestStore.getAll();
      getAllHarvests.onsuccess = () => {
        const items = (getAllHarvests.result || []) as StoredMuleHarvestEnvelope[];
        let changed = false;
        for (const item of items) {
          if (item && item.dedupKey && !this.harvestMap.has(item.dedupKey)) {
            this.harvestMap.set(item.dedupKey, item);
            changed = true;
          }
        }
        if (changed) {
          this.saveLocalStorageMirror();
          this.notifyListeners();
        }
      };
    } catch {
      // Non-fatal IndexedDB read error
    }
  }

  private persistEnvelopeToIndexedDb(envelope: StoredMuleHarvestEnvelope): void {
    if (typeof window === 'undefined' || !('indexedDB' in window)) return;
    this.openIndexedDb().then((db) => {
      if (!db) return;
      try {
        const tx = db.transaction(STORE_HARVESTS, 'readwrite');
        tx.objectStore(STORE_HARVESTS).put(envelope);
      } catch {
        // Ignore IndexedDB quota/tx errors
      }
    });
  }

  private saveLocalStorageMirror(): void {
    if (typeof window === 'undefined') return;
    try {
      const arr = Array.from(this.harvestMap.values()).sort(
        (a, b) => b.lastWitnessedAtUtc - a.lastWitnessedAtUtc
      );
      window.localStorage.setItem(LS_HARVEST_MIRROR_KEY, JSON.stringify(arr.slice(0, 250)));
      window.localStorage.setItem(
        LS_EPHEMERIS_MIRROR_KEY,
        JSON.stringify(this.ephemerisList.slice(0, 50))
      );
    } catch {
      // Ignore quota errors
    }
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /**
   * Ingests a raw 32-byte frame (either `0xA1` Sensor Harvest or `0xB2` Ridge-Mule Ephemeris)
   * received over 915 MHz LoRa BLE/Serial or local test harness.
   */
  public ingestRawMuleFrame(
    frame: Uint8Array | string,
    witnessNodeId: string = '!localNode',
    receivedAtUtc: number = Date.now()
  ): {
    kind: 'SENSOR_HARVEST' | 'RIDGE_EPHEMERIS';
    dedupKey: string;
    isDuplicate: boolean;
    macVerified: boolean;
  } {
    const decoded = decodeAnyMuleFrame(frame, receivedAtUtc);
    const witnessHash = hashWitnessNodeId(witnessNodeId);

    if (decoded.magic === 0xa1) {
      const existing = this.harvestMap.get(decoded.dedupKey);
      if (existing) {
        existing.lastWitnessedAtUtc = receivedAtUtc;
        if (!existing.witnessNodeHashes.includes(witnessHash)) {
          existing.witnessNodeHashes.push(witnessHash);
          existing.witnessCount = existing.witnessNodeHashes.length;
        } else {
          existing.witnessCount += 1;
        }
        this.harvestMap.set(decoded.dedupKey, existing);
        this.persistEnvelopeToIndexedDb(existing);
        this.saveLocalStorageMirror();
        this.notifyListeners();
        return {
          kind: 'SENSOR_HARVEST',
          dedupKey: decoded.dedupKey,
          isDuplicate: true,
          macVerified: decoded.macVerified,
        };
      }

      const envelope: StoredMuleHarvestEnvelope = {
        dedupKey: decoded.dedupKey,
        rawHex: decoded.rawHex,
        decoded,
        firstHarvestedAtUtc: receivedAtUtc,
        lastWitnessedAtUtc: receivedAtUtc,
        witnessCount: 1,
        witnessNodeHashes: [witnessHash],
        anonymousContributorToken: getAnonymousContributorToken(),
        syncStatus: decoded.macVerified ? 'QUEUED_OFFLINE' : 'REJECTED_INVALID_MAC',
      };

      this.harvestMap.set(decoded.dedupKey, envelope);
      this.persistEnvelopeToIndexedDb(envelope);
      this.saveLocalStorageMirror();
      this.notifyListeners();

      return {
        kind: 'SENSOR_HARVEST',
        dedupKey: decoded.dedupKey,
        isDuplicate: false,
        macVerified: decoded.macVerified,
      };
    } else {
      // 0xB2 Ridge-Mule Ephemeris frame
      const existingIdx = this.ephemerisList.findIndex((e) => e.dedupKey === decoded.dedupKey);
      const entry: StoredRidgeMuleEphemeris = {
        dedupKey: decoded.dedupKey,
        rawHex: decoded.rawHex,
        decoded,
        receivedAtUtc,
        sourceNodeId: witnessNodeId,
      };
      if (existingIdx >= 0) {
        this.ephemerisList[existingIdx] = entry;
      } else {
        this.ephemerisList.unshift(entry);
      }
      this.saveLocalStorageMirror();
      this.notifyListeners();

      return {
        kind: 'RIDGE_EPHEMERIS',
        dedupKey: decoded.dedupKey,
        isDuplicate: existingIdx >= 0,
        macVerified: decoded.macVerified,
      };
    }
  }

  /**
   * Creates, signs (SipHash-2-4), and ingests a new 32-byte `0xA1` Backcountry Sensor Harvest frame.
   * Returns the 32-byte Uint8Array and 64-char hex string ready for LoRa broadcast.
   */
  public createAndIngestSensorHarvest(
    input: SensorHarvestInput,
    witnessNodeId: string = '!localNode'
  ): { bytes: Uint8Array; hex: string; envelope: StoredMuleHarvestEnvelope } {
    const bytes = encodeSensorHarvestFrame(input);
    const hex = bytesToHex(bytes);
    const res = this.ingestRawMuleFrame(bytes, witnessNodeId, Date.now());
    const envelope = this.harvestMap.get(res.dedupKey)!;
    return { bytes, hex, envelope };
  }

  /**
   * Creates, signs (SipHash-2-4), and ingests a new 32-byte `0xB2` Ridge-Mule 24h USGS Hydrograph
   * & BiteWindow Ephemeris frame.
   */
  public createAndIngestRidgeEphemeris(
    input: RidgeMuleEphemerisInput,
    sourceNodeId: string = '!localNode'
  ): { bytes: Uint8Array; hex: string; ephemeris: StoredRidgeMuleEphemeris } {
    const bytes = encodeRidgeMuleEphemerisFrame(input);
    const hex = bytesToHex(bytes);
    const res = this.ingestRawMuleFrame(bytes, sourceNodeId, Date.now());
    const ephemeris = this.ephemerisList.find((e) => e.dedupKey === res.dedupKey)!;
    return { bytes, hex, ephemeris };
  }

  public getHarvestEnvelopes(): StoredMuleHarvestEnvelope[] {
    return Array.from(this.harvestMap.values()).sort(
      (a, b) => b.lastWitnessedAtUtc - a.lastWitnessedAtUtc
    );
  }

  public getRidgeEphemerisFrames(): StoredRidgeMuleEphemeris[] {
    return [...this.ephemerisList];
  }

  public getLatestRidgeEphemeris(): StoredRidgeMuleEphemeris | null {
    return this.ephemerisList.length > 0 ? this.ephemerisList[0] : null;
  }

  /**
   * Synchronizes all queued offline `0xA1` sensor harvest frames with the backend
   * `/__telemetry/mule-collector` agency collector gateway and merges the gateway ledger.
   */
  public async syncWithGateway(): Promise<CollectorGatewaySyncResponse> {
    const envelopes = this.getHarvestEnvelopes();
    const payload = {
      anonymousContributorToken: getAnonymousContributorToken(),
      submittedAtUtc: Date.now(),
      frames: envelopes.map((env) => ({
        rawHex: env.rawHex,
        harvestedAtUtc: env.firstHarvestedAtUtc,
        witnessNodeHashes: env.witnessNodeHashes,
      })),
    };

    const response = await fetch('/__telemetry/mule-collector', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Collector gateway returned HTTP ${response.status}`);
    }

    const data = (await response.json()) as CollectorGatewaySyncResponse;
    const now = Date.now();

    // Update local statuses and merge any basin records from the gateway ledger
    for (const env of this.harvestMap.values()) {
      if (env.decoded.macVerified) {
        env.syncStatus = 'SYNCED_TO_COLLECTOR';
        env.syncedAtUtc = now;
        env.collectorReceiptId = data.receiptId;
        this.persistEnvelopeToIndexedDb(env);
      }
    }

    if (Array.isArray(data.records)) {
      for (const remoteRecord of data.records) {
        if (remoteRecord && remoteRecord.dedupKey) {
          const local = this.harvestMap.get(remoteRecord.dedupKey);
          if (!local || remoteRecord.witnessCount >= local.witnessCount) {
            this.harvestMap.set(remoteRecord.dedupKey, {
              ...remoteRecord,
              syncStatus: 'SYNCED_TO_COLLECTOR',
            });
          }
        }
      }
    }

    this.saveLocalStorageMirror();
    this.notifyListeners();
    return data;
  }

  /**
   * Generates a strict RFC 7946 GeoJSON FeatureCollection of all SipHash-verified
   * backcountry sensor harvests for direct import into QGIS, ArcGIS, USGS WaterWatch,
   * or USFS WFDSS.
   */
  public exportVerifiedHarvestsAsGeoJson(): string {
    const verified = this.getHarvestEnvelopes().filter((e) => e.decoded.macVerified);
    const featureCollection = {
      type: 'FeatureCollection',
      metadata: {
        generator: 'MeshMule-Core / BiteWindow Vector7 (32-Byte LoRa Binary Telemetry)',
        exportedAtIso: new Date().toISOString(),
        featureCount: verified.length,
        cryptographicAuth: 'SipHash-2-4-32bit-MAC',
      },
      features: verified.map((env) => ({
        type: 'Feature',
        id: env.dedupKey,
        geometry: {
          type: 'Point',
          coordinates: [
            env.decoded.lon,
            env.decoded.lat,
            env.decoded.elevationMeters,
          ],
        },
        properties: {
          dedupKey: env.dedupKey,
          stationCallsign: env.decoded.stationCallsign,
          sequenceNumber: env.decoded.sequenceNumber,
          domainCode: env.decoded.domain,
          domainLabel: env.decoded.domainLabel,
          correctedSampleIso: new Date(env.decoded.correctedSampleUtc).toISOString(),
          relativeAgeSecondsAtHarvest: env.decoded.relativeAgeSeconds,
          primaryLabel: env.decoded.primaryMetric.label,
          primaryValue: env.decoded.primaryMetric.value,
          primaryUnit: env.decoded.primaryMetric.unit,
          secondaryLabel: env.decoded.secondaryMetric.label,
          secondaryValue: env.decoded.secondaryMetric.value,
          secondaryUnit: env.decoded.secondaryMetric.unit,
          tertiaryLabel: env.decoded.tertiaryMetric.label,
          tertiaryValue: env.decoded.tertiaryMetric.value,
          tertiaryUnit: env.decoded.tertiaryMetric.unit,
          batteryPercent: env.decoded.batteryPercent,
          solarCharging: env.decoded.solarCharging,
          thresholdExceeded: env.decoded.thresholdExceeded,
          tamperAlert: env.decoded.tamperAlert,
          macHex: env.decoded.computedMacHex,
          macVerified: env.decoded.macVerified,
          witnessCount: env.witnessCount,
          syncStatus: env.syncStatus,
          rawFrameHex32B: env.rawHex,
        },
      })),
    };
    return JSON.stringify(featureCollection, null, 2);
  }

  /**
   * Generates a scientific flat CSV table of all SipHash-verified sensor harvests.
   */
  public exportVerifiedHarvestsAsCsv(): string {
    const verified = this.getHarvestEnvelopes().filter((e) => e.decoded.macVerified);
    const headers = [
      'dedup_key',
      'station_callsign',
      'seq_num',
      'domain_label',
      'corrected_sample_iso',
      'lat',
      'lon',
      'elevation_m',
      'primary_metric',
      'primary_value',
      'primary_unit',
      'secondary_metric',
      'secondary_value',
      'secondary_unit',
      'tertiary_metric',
      'tertiary_value',
      'tertiary_unit',
      'battery_pct',
      'solar_charging',
      'threshold_exceeded',
      'witness_count',
      'siphash_mac',
      'raw_32b_hex',
    ];

    const rows = verified.map((env) => {
      const d = env.decoded;
      const cols = [
        env.dedupKey,
        d.stationCallsign,
        d.sequenceNumber,
        `"${d.domainLabel}"`,
        new Date(d.correctedSampleUtc).toISOString(),
        d.lat,
        d.lon,
        d.elevationMeters,
        `"${d.primaryMetric.label}"`,
        d.primaryMetric.value,
        `"${d.primaryMetric.unit}"`,
        `"${d.secondaryMetric.label}"`,
        d.secondaryMetric.value,
        `"${d.secondaryMetric.unit}"`,
        `"${d.tertiaryMetric.label}"`,
        d.tertiaryMetric.value,
        `"${d.tertiaryMetric.unit}"`,
        d.batteryPercent,
        d.solarCharging,
        d.thresholdExceeded,
        env.witnessCount,
        d.computedMacHex,
        env.rawHex,
      ];
      return cols.join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  }
}

export const muleCollectorService = new MuleCollectorService();
