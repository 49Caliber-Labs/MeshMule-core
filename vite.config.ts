import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import {
  MuleSensorDomain,
  SensorHarvestInput,
  bytesToHex,
  decodeSensorHarvestFrame,
  encodeSensorHarvestFrame,
} from './src/mesh-core/muleCodec';

export default defineConfig(() => {
  const ledgerDir = path.resolve(__dirname, 'data');
  const ledgerFilePath = path.join(ledgerDir, 'mule-collector-ledger.json');

  const ensureLedgerLoaded = (): Record<string, any> => {
    try {
      if (fs.existsSync(ledgerFilePath)) {
        const raw = fs.readFileSync(ledgerFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      }
    } catch {
      // Rebuild if missing or corrupted
    }

    const now = Date.now();
    const initialSeeds: SensorHarvestInput[] = [
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
        primaryValue: 64.8,
        secondaryValue: 412,
        tertiaryValue: 98.4,
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
        primaryValue: 11.4,
        secondaryValue: 645,
        tertiaryValue: 10.6,
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
        primaryValue: 28.4,
        secondaryValue: 16,
        tertiaryValue: 7.2,
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
        primaryValue: 13.2,
        secondaryValue: 38,
        tertiaryValue: 9.8,
        stepIntervalMinutes: 15,
        historicalPrimarySeries: [13.5, 13.4, 13.4, 13.3, 13.2, 13.2],
      },
    ];

    const seededLedger: Record<string, any> = {};
    for (const seed of initialSeeds) {
      const bytes = encodeSensorHarvestFrame(seed);
      const rawHex = bytesToHex(bytes);
      const decoded = decodeSensorHarvestFrame(bytes, now);
      seededLedger[decoded.dedupKey] = {
        dedupKey: decoded.dedupKey,
        rawHex,
        decoded,
        firstHarvestedAtUtc: now - seed.relativeAgeSeconds * 1000,
        lastWitnessedAtUtc: now,
        witnessCount: 1,
        witnessNodeHashes: ['W-SEED01'],
        anonymousContributorToken: 'MULE-GATEWAY-SEED',
        syncStatus: 'SYNCED_TO_COLLECTOR',
        syncedAtUtc: now,
        collectorReceiptId: 'RCPT-INIT-0001',
      };
    }

    try {
      if (!fs.existsSync(ledgerDir)) {
        fs.mkdirSync(ledgerDir, { recursive: true });
      }
      fs.writeFileSync(ledgerFilePath, JSON.stringify(seededLedger, null, 2), 'utf-8');
    } catch {
      // Ignore write error in read-only environments
    }

    return seededLedger;
  };

  const persistLedger = (ledger: Record<string, any>) => {
    try {
      if (!fs.existsSync(ledgerDir)) {
        fs.mkdirSync(ledgerDir, { recursive: true });
      }
      fs.writeFileSync(ledgerFilePath, JSON.stringify(ledger, null, 2), 'utf-8');
    } catch {
      // Ignore write error
    }
  };

  return {
    plugins: [
      {
        name: 'meshmule-collector-gateway',
        configureServer(server) {
          server.middlewares.use('/__radio_diag', (req, res) => {
            if (req.method === 'POST') {
              let body = '';
              req.on('data', (chunk) => {
                body += chunk;
              });
              req.on('end', () => {
                console.log('[RADIO_DIAG]', body);
                res.statusCode = 204;
                res.end();
              });
            } else {
              res.statusCode = 200;
              res.end('ok');
            }
          });

          server.middlewares.use('/__telemetry/mule-collector', (req, res) => {
            const ledger = ensureLedgerLoaded();
            const urlObj = new URL(req.url || '/', 'http://localhost');
            const format = (urlObj.searchParams.get('format') || 'json').toLowerCase();

            if (req.method === 'POST') {
              let body = '';
              req.on('data', (chunk) => {
                body += chunk;
              });
              req.on('end', () => {
                try {
                  const parsed = JSON.parse(body || '{}');
                  const anonToken =
                    typeof parsed.anonymousContributorToken === 'string'
                      ? parsed.anonymousContributorToken
                      : 'MULE-ANON-0000';
                  const frames = Array.isArray(parsed.frames) ? parsed.frames : [];

                  let ingestedCount = 0;
                  let deduplicatedCount = 0;
                  let rejectedMacCount = 0;
                  const now = Date.now();
                  const receiptId = 'RCPT-' + Math.floor(now / 1000).toString(16).toUpperCase();

                  for (const item of frames) {
                    if (!item || typeof item.rawHex !== 'string') continue;
                    const harvestedAt =
                      typeof item.harvestedAtUtc === 'number' ? item.harvestedAtUtc : now;
                    const decoded = decodeSensorHarvestFrame(item.rawHex, harvestedAt);
                    if (!decoded.macVerified) {
                      rejectedMacCount++;
                      continue;
                    }

                    const incomingWitnesses: string[] = Array.isArray(item.witnessNodeHashes)
                      ? item.witnessNodeHashes.filter((w: any) => typeof w === 'string')
                      : ['W-REMOTE'];

                    const existing = ledger[decoded.dedupKey];
                    if (existing) {
                      existing.lastWitnessedAtUtc = now;
                      const mergedWitnesses = new Set<string>([
                        ...(Array.isArray(existing.witnessNodeHashes)
                          ? existing.witnessNodeHashes
                          : []),
                        ...incomingWitnesses,
                      ]);
                      existing.witnessNodeHashes = Array.from(mergedWitnesses);
                      existing.witnessCount = Math.max(
                        existing.witnessCount || 1,
                        existing.witnessNodeHashes.length
                      );
                      existing.syncStatus = 'SYNCED_TO_COLLECTOR';
                      existing.syncedAtUtc = now;
                      existing.collectorReceiptId = receiptId;
                      deduplicatedCount++;
                    } else {
                      ledger[decoded.dedupKey] = {
                        dedupKey: decoded.dedupKey,
                        rawHex: decoded.rawHex,
                        decoded,
                        firstHarvestedAtUtc: harvestedAt,
                        lastWitnessedAtUtc: now,
                        witnessCount: Math.max(1, incomingWitnesses.length),
                        witnessNodeHashes: incomingWitnesses,
                        anonymousContributorToken: anonToken,
                        syncStatus: 'SYNCED_TO_COLLECTOR',
                        syncedAtUtc: now,
                        collectorReceiptId: receiptId,
                      };
                      ingestedCount++;
                    }
                  }

                  persistLedger(ledger);
                  const records = Object.values(ledger).sort(
                    (a: any, b: any) => (b.lastWitnessedAtUtc || 0) - (a.lastWitnessedAtUtc || 0)
                  );

                  res.setHeader('Content-Type', 'application/json');
                  res.statusCode = 200;
                  res.end(
                    JSON.stringify({
                      ok: true,
                      ingestedCount,
                      deduplicatedCount,
                      rejectedMacCount,
                      totalLedgerRecords: records.length,
                      receiptId,
                      records,
                    })
                  );
                } catch (err: any) {
                  res.setHeader('Content-Type', 'application/json');
                  res.statusCode = 400;
                  res.end(
                    JSON.stringify({
                      ok: false,
                      error: err?.message || 'Invalid MeshMule frame batch payload',
                    })
                  );
                }
              });
              return;
            }

            const records = Object.values(ledger).sort(
              (a: any, b: any) => (b.lastWitnessedAtUtc || 0) - (a.lastWitnessedAtUtc || 0)
            );

            if (format === 'geojson') {
              const featureCollection = {
                type: 'FeatureCollection',
                metadata: {
                  generator: 'MeshMule-Core Agency Collector Gateway (49Caliber Labs)',
                  exportedAtIso: new Date().toISOString(),
                  featureCount: records.length,
                  cryptographicAuth: 'SipHash-2-4-32bit-MAC',
                },
                features: records.map((env: any) => ({
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
                    domainLabel: env.decoded.domainLabel,
                    correctedSampleIso: new Date(env.decoded.correctedSampleUtc).toISOString(),
                    primaryMetric: env.decoded.primaryMetric,
                    secondaryMetric: env.decoded.secondaryMetric,
                    tertiaryMetric: env.decoded.tertiaryMetric,
                    batteryPercent: env.decoded.batteryPercent,
                    solarCharging: env.decoded.solarCharging,
                    thresholdExceeded: env.decoded.thresholdExceeded,
                    witnessCount: env.witnessCount,
                    macHex: env.decoded.computedMacHex,
                    rawFrameHex32B: env.rawHex,
                  },
                })),
              };
              res.setHeader('Content-Type', 'application/geo+json');
              res.statusCode = 200;
              res.end(JSON.stringify(featureCollection, null, 2));
              return;
            }

            if (format === 'csv') {
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
                'witness_count',
                'siphash_mac',
                'raw_32b_hex',
              ];
              const rows = records.map((env: any) => {
                const d = env.decoded;
                return [
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
                  env.witnessCount,
                  d.computedMacHex,
                  env.rawHex,
                ].join(',');
              });
              res.setHeader('Content-Type', 'text/csv');
              res.statusCode = 200;
              res.end([headers.join(','), ...rows].join('\n'));
              return;
            }

            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 200;
            res.end(
              JSON.stringify({
                ok: true,
                totalLedgerRecords: records.length,
                records,
              })
            );
          });
        },
      },
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        manifest: {
          name: 'MeshMule-Core 915 MHz Off-Grid Telemetry & SAR Engine',
          short_name: 'MeshMule-Core',
          description:
            'Open-Source 915 MHz Citizen-Science Delay-Tolerant Networking, Distributed Barometric Phased-Array, & GPS-Denied SAR Engine',
          theme_color: '#0b2545',
          background_color: '#0b132b',
          display: 'standalone',
        },
      }),
    ],
  };
});
