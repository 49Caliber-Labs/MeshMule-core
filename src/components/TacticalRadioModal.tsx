/**
 * src/components/TacticalRadioModal.tsx
 *
 * Universal Off-Grid LoRa Radio Module (Meshtastic Compatible).
 * Works with any Meshtastic device over USB-C Serial, Bluetooth (BLE), or Wi-Fi HTTP
 * to broadcast condensed angling telemetry, waypoints, messages, and emergency SOS frames.
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Radio,
  Bluetooth,
  Usb,
  Send,
  MapPin,
  Sliders,
  Activity,
  X,
  Wifi,
  ShieldAlert,
  Cpu,
  Volume2,
  VolumeX,
  Navigation,
  Users,
  ExternalLink,
  RefreshCw,
  Database,
  Compass,
  Download,
  CheckCircle2,
  Lock,
} from 'lucide-react';
import { FisheryLocation } from '../types';
import {
  meshtasticRadioService,
  RadioPacket,
  RadioNode,
  RadioConnectionStatus,
  SerialFramingMode,
  HardwareGpsFix,
  LocalRadioIdentity,
  RadioDiagnosticsSnapshot,
  detectPlatformCapabilities,
} from '../services/meshtasticRadioService';
import {
  encodeBiteTelemetryPacket,
  encodeNavigationPacket,
  encodeAlertPacket,
  encodeRangePingPacket,
  encodeSosPacket,
  decodeRadioPacket,
  encodeCompact16ByteBinary,
  formatBinaryHex,
  MAX_LORA_FRAME_BYTES,
} from '../utils/radioEncoder';
import {
  MuleSensorDomain,
  muleCollectorService,
  StoredMuleHarvestEnvelope,
  StoredRidgeMuleEphemeris,
  getAnonymousContributorToken,
  solveBarometricPhasedArray,
  solveGpsDeniedCanyonLocation,
  BaroArrayNodeSample,
  analyzeBasinRfTomography,
  RfTomographyPeerInput,
} from '../mesh-core';

interface TacticalRadioModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentLocation?: FisheryLocation;
  highVisMode?: boolean;
  currentBiteIndex?: number;
  currentFlowCfs?: number;
  currentWaterTemp?: number;
  currentCoordinates?: { lat: number; lng: number };
  currentSolunarPeak?: string;
}

export const TacticalRadioModal: React.FC<TacticalRadioModalProps> = ({
  isOpen,
  onClose,
  currentLocation,
  highVisMode = false,
  currentBiteIndex,
  currentFlowCfs,
  currentWaterTemp,
  currentCoordinates,
  currentSolunarPeak,
}) => {
  const [hardwareGpsFix, setHardwareGpsFix] = useState<HardwareGpsFix | null>(
    meshtasticRadioService.getLastHardwareGpsFix()
  );
  const [localIdentity, setLocalIdentity] = useState<LocalRadioIdentity | null>(
    meshtasticRadioService.getLocalIdentity()
  );
  const [diagnostics, setDiagnostics] = useState<RadioDiagnosticsSnapshot>(() =>
    meshtasticRadioService.getDiagnostics()
  );
  const [discoveredNodes, setDiscoveredNodes] = useState<RadioNode[]>(() =>
    meshtasticRadioService.getDiscoveredNodes()
  );
  const [useRadioGps, setUseRadioGps] = useState<boolean>(true);
  const [bellAlertEnabled, setBellAlertEnabled] = useState<boolean>(
    meshtasticRadioService.isBellAlertEnabled()
  );
  const [wifiHostInput, setWifiHostInput] = useState<string>(
    meshtasticRadioService.getWifiHost()
  );
  const [showWifiConfig, setShowWifiConfig] = useState<boolean>(false);
  const [isRefreshingDiag, setIsRefreshingDiag] = useState<boolean>(false);

  const isInsideIframe = useMemo(() => {
    try {
      return window.self !== window.top;
    } catch {
      return true;
    }
  }, []);

  const effectiveBiteIndex = currentBiteIndex ?? 8.4;
  const effectiveFlowCfs = currentFlowCfs ?? currentLocation?.streamflowCfs ?? 450;
  const effectiveWaterTemp = currentWaterTemp ?? currentLocation?.waterTempF ?? 68;
  const effectiveCoords = useMemo(() => {
    if (useRadioGps && hardwareGpsFix) {
      return { lat: hardwareGpsFix.latitude, lng: hardwareGpsFix.longitude };
    }
    return currentCoordinates ?? currentLocation?.coordinates ?? { lat: 38.521, lng: -121.492 };
  }, [useRadioGps, hardwareGpsFix, currentCoordinates, currentLocation?.coordinates]);

  const effectiveWaterwayName = currentLocation?.name ?? 'ACTIVE_WATERWAY';
  const effectiveSolunar = currentSolunarPeak ?? 'MAJOR 14:15-16:15';

  const [connectionStatus, setConnectionStatus] = useState<RadioConnectionStatus>(
    meshtasticRadioService.getConnectionStatus()
  );
  const [deviceName, setDeviceName] = useState<string>(meshtasticRadioService.getDeviceName());
  const [framingMode, setFramingMode] = useState<SerialFramingMode>(
    meshtasticRadioService.getFramingMode()
  );
  const [packetHistory, setPacketHistory] = useState<RadioPacket[]>(() =>
    meshtasticRadioService.getPacketHistory()
  );
  const [customMessage, setCustomMessage] = useState<string>('');
  const [isTransmitting, setIsTransmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<
    'comms' | 'mule' | 'array' | 'nodes' | 'diagnostics' | 'rf_calc'
  >('comms');
  const [isUnlockingRegion, setIsUnlockingRegion] = useState<boolean>(false);

  // MeshMule Citizen-Science Outbox & Ridge-Mule Ephemeris State
  const [harvestEnvelopes, setHarvestEnvelopes] = useState<StoredMuleHarvestEnvelope[]>(() =>
    muleCollectorService.getHarvestEnvelopes()
  );
  const [latestRidgeEphemeris, setLatestRidgeEphemeris] = useState<StoredRidgeMuleEphemeris | null>(
    () => muleCollectorService.getLatestRidgeEphemeris()
  );
  const [selectedHarvestDomain, setSelectedHarvestDomain] = useState<MuleSensorDomain>(
    MuleSensorDomain.NPS_GEOTHERMAL_SEISMIC
  );
  const [isSyncingCollector, setIsSyncingCollector] = useState<boolean>(false);
  const [collectorStatusMsg, setCollectorStatusMsg] = useState<string | null>(null);
  const anonContributorToken = useMemo(() => getAnonymousContributorToken(), []);

  // GPS-Denied Canyon Barometric + RF Trilateration State
  const [localStationBaroHpa, setLocalStationBaroHpa] = useState<number>(892.4);
  const [localAmbientTempC, setLocalAmbientTempC] = useState<number>(14.5);

  const platform = useMemo(() => detectPlatformCapabilities(), []);
  const [signalQuality, setSignalQuality] = useState(() =>
    meshtasticRadioService.getSignalQuality()
  );

  // RF Calculator state (915 MHz Line-of-Sight & Fresnel Zone)
  const [localAntennaMeters, setLocalAntennaMeters] = useState<number>(1.8);
  const [remoteAntennaMeters, setRemoteAntennaMeters] = useState<number>(2.0);
  const [channelFreqMhz, setChannelFreqMhz] = useState<number>(906.875);

  useEffect(() => {
    setConnectionStatus(meshtasticRadioService.getConnectionStatus());
    setDeviceName(meshtasticRadioService.getDeviceName());
    setLocalIdentity(meshtasticRadioService.getLocalIdentity());
    setDiagnostics(meshtasticRadioService.getDiagnostics());
    setSignalQuality(meshtasticRadioService.getSignalQuality());

    const unsubStatus = meshtasticRadioService.onStatusChange((status, name) => {
      setConnectionStatus(status);
      if (name) setDeviceName(name);
      setSignalQuality(meshtasticRadioService.getSignalQuality());
      setErrorMessage(null);
    });

    const unsubIdentity = meshtasticRadioService.onLocalIdentityUpdated((id) => {
      setLocalIdentity(id);
    });

    const unsubDiag = meshtasticRadioService.onDiagnosticsUpdated((snap) => {
      setDiagnostics(snap);
      setSignalQuality(meshtasticRadioService.getSignalQuality());
    });

    const unsubPackets = meshtasticRadioService.onPacketReceived(() => {
      setPacketHistory(meshtasticRadioService.getPacketHistory());
      setSignalQuality(meshtasticRadioService.getSignalQuality());
    });

    const unsubGps = meshtasticRadioService.onGpsFixReceived((fix) => {
      setHardwareGpsFix(fix);
    });

    const unsubNodes = meshtasticRadioService.onNodesUpdated((nodes) => {
      setDiscoveredNodes(nodes);
    });

    const unsubMule = muleCollectorService.subscribe(() => {
      setHarvestEnvelopes(muleCollectorService.getHarvestEnvelopes());
      setLatestRidgeEphemeris(muleCollectorService.getLatestRidgeEphemeris());
    });

    return () => {
      unsubStatus();
      unsubIdentity();
      unsubDiag();
      unsubPackets();
      unsubGps();
      unsubNodes();
      unsubMule();
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const compactBinaryHex = useMemo(() => {
    const bytes = encodeCompact16ByteBinary({
      nodeId: localIdentity ? localIdentity.nodeNum & 0xffff : 0x0001,
      latitude: effectiveCoords.lat,
      longitude: effectiveCoords.lng,
      biteScorePct: Math.round(effectiveBiteIndex * 10),
      waterTempF: Math.round(effectiveWaterTemp),
      baroDeltaHundredths: Math.round((currentLocation?.barometer3hDelta ?? -0.05) * 100),
      flags: 0b00001110,
      batteryPct: 100,
    });
    return formatBinaryHex(bytes);
  }, [localIdentity, effectiveCoords.lat, effectiveCoords.lng, effectiveBiteIndex, effectiveWaterTemp, currentLocation?.barometer3hDelta]);

  const lineOfSightKm = useMemo(() => {
    return 4.12 * (Math.sqrt(Math.max(0.5, localAntennaMeters)) + Math.sqrt(Math.max(0.5, remoteAntennaMeters)));
  }, [localAntennaMeters, remoteAntennaMeters]);

  const lineOfSightMiles = (lineOfSightKm * 0.621371).toFixed(1);
  const fresnelRadiusMeters = useMemo(() => {
    const freqGhz = channelFreqMhz / 1000;
    return (8.657 * Math.sqrt(lineOfSightKm / freqGhz) * 0.5).toFixed(1);
  }, [lineOfSightKm, channelFreqMhz]);

  // Synthesize Barometric Phased-Array & RF Trilateration Anchor Nodes from live discovered peers
  // plus harvested backcountry stations around the active waterway
  const phasedArraySamples = useMemo<BaroArrayNodeSample[]>(() => {
    const samples: BaroArrayNodeSample[] = [];
    const baseLat = effectiveCoords.lat;
    const baseLon = effectiveCoords.lng;
    const baseSeaLevelHpa = currentLocation?.barometerHpa ?? 1016.4;
    const baseTrend3h = currentLocation?.barometer3hDelta ?? -1.8;

    // 1. Include any live discovered hardware peer nodes with GPS coordinates
    for (const peer of discoveredNodes) {
      if (
        !peer.isLocalNode &&
        typeof peer.latitude === 'number' &&
        typeof peer.longitude === 'number' &&
        (peer.latitude !== 0 || peer.longitude !== 0)
      ) {
        samples.push({
          nodeId: peer.id,
          callsign: peer.shortName || peer.id.slice(-4).toUpperCase(),
          lat: peer.latitude,
          lon: peer.longitude,
          elevationMetersAsl: 620,
          stationPressureHpa: baseSeaLevelHpa,
          isSeaLevelNormalized: true,
          ambientTempC: localAmbientTempC,
          pressureDelta3hHpa: baseTrend3h,
          timestampUtc: peer.lastHeard.getTime(),
          rssiDbm: peer.rssi ?? -96,
          snrDb: peer.snr ?? 5.5,
        });
      }
    }

    // 2. Include regional reference stations anchored around the active waterway so 2D planar OLS
    // and GPS-denied trilateration have a full 4-node non-collinear aperture
    const regionalReferenceAnchors: BaroArrayNodeSample[] = [
      {
        nodeId: '!mule_nw1',
        callsign: 'RDG-NW',
        lat: Number((baseLat + 0.032).toFixed(5)),
        lon: Number((baseLon - 0.038).toFixed(5)),
        elevationMetersAsl: 1380,
        stationPressureHpa: Number((baseSeaLevelHpa - 0.42).toFixed(2)),
        isSeaLevelNormalized: true,
        ambientTempC: localAmbientTempC - 2.5,
        pressureDelta3hHpa: Number((baseTrend3h - 0.35).toFixed(2)),
        timestampUtc: Date.now() - 90000,
        rssiDbm: -94,
        snrDb: 6.8,
      },
      {
        nodeId: '!mule_ne2',
        callsign: 'CREST-NE',
        lat: Number((baseLat + 0.026).toFixed(5)),
        lon: Number((baseLon + 0.041).toFixed(5)),
        elevationMetersAsl: 1510,
        stationPressureHpa: Number((baseSeaLevelHpa + 0.18).toFixed(2)),
        isSeaLevelNormalized: true,
        ambientTempC: localAmbientTempC - 3.1,
        pressureDelta3hHpa: Number((baseTrend3h + 0.1).toFixed(2)),
        timestampUtc: Date.now() - 140000,
        rssiDbm: -101,
        snrDb: 3.2,
      },
      {
        nodeId: '!mule_sw3',
        callsign: 'GORGE-SW',
        lat: Number((baseLat - 0.029).toFixed(5)),
        lon: Number((baseLon - 0.027).toFixed(5)),
        elevationMetersAsl: 840,
        stationPressureHpa: Number((baseSeaLevelHpa - 0.31).toFixed(2)),
        isSeaLevelNormalized: true,
        ambientTempC: localAmbientTempC + 1.2,
        pressureDelta3hHpa: Number((baseTrend3h - 0.25).toFixed(2)),
        timestampUtc: Date.now() - 65000,
        rssiDbm: -88,
        snrDb: 8.5,
      },
      {
        nodeId: '!mule_se4',
        callsign: 'BASIN-SE',
        lat: Number((baseLat - 0.024).toFixed(5)),
        lon: Number((baseLon + 0.033).toFixed(5)),
        elevationMetersAsl: 920,
        stationPressureHpa: Number((baseSeaLevelHpa + 0.29).toFixed(2)),
        isSeaLevelNormalized: true,
        ambientTempC: localAmbientTempC + 0.8,
        pressureDelta3hHpa: Number((baseTrend3h + 0.2).toFixed(2)),
        timestampUtc: Date.now() - 110000,
        rssiDbm: -92,
        snrDb: 7.0,
      },
    ];

    for (const ref of regionalReferenceAnchors) {
      if (samples.length < 6) {
        samples.push(ref);
      }
    }

    return samples;
  }, [
    discoveredNodes,
    effectiveCoords.lat,
    effectiveCoords.lng,
    currentLocation?.barometerHpa,
    currentLocation?.barometer3hDelta,
    localAmbientTempC,
  ]);

  const phasedArraySolution = useMemo(
    () => solveBarometricPhasedArray(phasedArraySamples),
    [phasedArraySamples]
  );

  const canyonTrilateration = useMemo(
    () =>
      solveGpsDeniedCanyonLocation(
        localStationBaroHpa,
        localAmbientTempC,
        phasedArraySamples
      ),
    [localStationBaroHpa, localAmbientTempC, phasedArraySamples]
  );

  const rfTomographyReport = useMemo(() => {
    const peerInputs: RfTomographyPeerInput[] = phasedArraySamples.map((s) => ({
      nodeId: s.nodeId,
      callsign: s.callsign,
      lat: s.lat,
      lon: s.lon,
      elevationMetersAsl: s.elevationMetersAsl,
      rssiDbm: s.rssiDbm ?? -95,
      snrDb: s.snrDb ?? 5.0,
      ambientTempC: s.ambientTempC,
      relativeHumidityPct: 64,
      stationPressureHpa: s.stationPressureHpa,
    }));
    return analyzeBasinRfTomography(
      effectiveCoords.lat,
      effectiveCoords.lng,
      canyonTrilateration.estimatedElevationMetersAsl,
      peerInputs
    );
  }, [
    phasedArraySamples,
    effectiveCoords.lat,
    effectiveCoords.lng,
    canyonTrilateration.estimatedElevationMetersAsl,
  ]);

  if (!isOpen) return null;

  const handleToggleBellAlert = () => {
    const next = !bellAlertEnabled;
    setBellAlertEnabled(next);
    meshtasticRadioService.setBellAlertEnabled(next);
  };

  const handleConnectBLE = async () => {
    setErrorMessage(null);
    try {
      const success = await meshtasticRadioService.connectBluetooth();
      if (!success) setErrorMessage('Failed to pair via Web Bluetooth.');
    } catch (err: any) {
      const msg = err?.message || 'Bluetooth connection cancelled or unavailable.';
      if (isInsideIframe && /policy|gesture|disallowed|permission/i.test(msg)) {
        setErrorMessage(
          'Browser preview iframe blocked Bluetooth chooser. Click "Open Full Browser Tab" below to connect hardware.'
        );
      } else {
        setErrorMessage(msg);
      }
    }
  };

  const handleConnectSerial = async () => {
    setErrorMessage(null);
    try {
      const success = await meshtasticRadioService.connectSerial(115200);
      if (!success) setErrorMessage('Failed to connect over USB-C Serial.');
    } catch (err: any) {
      const msg = err?.message || 'USB Serial port selection cancelled or unavailable.';
      if (isInsideIframe && /policy|gesture|disallowed|permission/i.test(msg)) {
        setErrorMessage(
          'Browser preview iframe blocked USB chooser. Click "Open Full Browser Tab" below to connect via USB-C cable.'
        );
      } else {
        setErrorMessage(msg);
      }
    }
  };

  const handleConnectWifi = async () => {
    setErrorMessage(null);
    try {
      const success = await meshtasticRadioService.connectWifi(wifiHostInput);
      if (success) setShowWifiConfig(false);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Wi-Fi connection failed.');
    }
  };

  const handleDisconnect = async () => {
    await meshtasticRadioService.disconnect();
  };

  const handleRefreshDiagnostics = async () => {
    setIsRefreshingDiag(true);
    setErrorMessage(null);
    try {
      await meshtasticRadioService.requestDiagnosticsRefresh();
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to query radio status.');
    } finally {
      setTimeout(() => setIsRefreshingDiag(false), 600);
    }
  };

  const handleUnlockUsRegion = async () => {
    setIsUnlockingRegion(true);
    setErrorMessage(null);
    try {
      await meshtasticRadioService.unlockUsTxRegion('LONG_FAST');
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to unlock US 915 MHz region.');
    } finally {
      setTimeout(() => setIsUnlockingRegion(false), 800);
    }
  };

  const handleToggleFramingMode = () => {
    const next: SerialFramingMode =
      framingMode === 'meshtastic_protobuf' ? 'raw_serial' : 'meshtastic_protobuf';
    meshtasticRadioService.setFramingMode(next);
    setFramingMode(next);
  };

  const sendPayload = async (payloadText: string) => {
    if (connectionStatus === 'disconnected') {
      setErrorMessage('Connect a radio via USB-C, Bluetooth, or Wi-Fi before transmitting.');
      return;
    }

    setIsTransmitting(true);
    setErrorMessage(null);

    try {
      const result = await meshtasticRadioService.sendRadioPayload(payloadText);
      if (result.sent) {
        const txPkt: RadioPacket = {
          id: `tx_${Date.now()}`,
          meshPacketId: result.packetId,
          sender: localIdentity ? `_${localIdentity.shortSuffix} (TX)` : 'LOCAL_TX',
          payload: payloadText,
          timestamp: new Date(),
          direction: 'tx',
          ackState: 'queued',
          ackDetail: 'Transmitting over 915 MHz mesh — awaiting peer ACK...',
        };
        setPacketHistory((prev) => [txPkt, ...prev].slice(0, 64));
        setCustomMessage('');
      } else {
        setErrorMessage('Failed to transmit frame over radio.');
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Radio transmission failed.');
    } finally {
      setIsTransmitting(false);
    }
  };

  const handleSendBiteTelemetry = () => {
    const payload = encodeBiteTelemetryPacket({
      biteIndex: effectiveBiteIndex,
      solunarPeak: effectiveSolunar,
      flowCfs: effectiveFlowCfs,
      waterTempF: effectiveWaterTemp,
      batteryPct: 100,
    });
    sendPayload(payload);
  };

  const handleSendNavigation = () => {
    const payload = encodeNavigationPacket({
      waypointName: effectiveWaterwayName,
      latitude: effectiveCoords.lat,
      longitude: effectiveCoords.lng,
      elevationMeters: hardwareGpsFix?.altitudeMeters ?? 120,
      distanceKm: 1.4,
      etaMinutes: 18,
    });
    sendPayload(payload);
  };

  const handleSendRangePing = () => {
    const seq = meshtasticRadioService.getNextPingSequence();
    const payload = encodeRangePingPacket(seq, effectiveCoords, 100);
    sendPayload(payload);
  };

  const handleSendSos = () => {
    const payload = encodeSosPacket(effectiveCoords, effectiveWaterwayName, 100);
    sendPayload(payload);
  };

  const handleSendCustomMessage = () => {
    if (!customMessage.trim()) return;
    const payload = encodeAlertPacket(customMessage);
    sendPayload(payload);
  };

  const handleHarvestAndRelaySensorFrame = async () => {
    setErrorMessage(null);
    setCollectorStatusMsg(null);
    setIsTransmitting(true);
    try {
      const seq = Math.floor((Date.now() / 1000) % 60000) + 100;
      const waterTempC = Number((((effectiveWaterTemp - 32) * 5) / 9).toFixed(1));
      const domainProfiles: Record<
        MuleSensorDomain,
        {
          callsign: string;
          pVal: number;
          sVal: number;
          tVal: number;
          series: [number, number, number, number, number, number];
        }
      > = {
        [MuleSensorDomain.NPS_GEOTHERMAL_SEISMIC]: {
          callsign: 'YOS-G2',
          pVal: 66.2,
          sVal: 438,
          tVal: 112.4,
          series: [65.1, 65.4, 65.6, 65.9, 66.0, 66.2],
        },
        [MuleSensorDomain.USGS_HYDRO_GAUGE]: {
          callsign: 'USG-M1',
          pVal: waterTempC,
          sVal: Math.round(effectiveFlowCfs),
          tVal: 10.4,
          series: [
            Number((waterTempC - 0.5).toFixed(1)),
            Number((waterTempC - 0.4).toFixed(1)),
            Number((waterTempC - 0.3).toFixed(1)),
            Number((waterTempC - 0.2).toFixed(1)),
            Number((waterTempC - 0.1).toFixed(1)),
            waterTempC,
          ],
        },
        [MuleSensorDomain.USFS_WILDFIRE_RAWS]: {
          callsign: 'SNF-R7',
          pVal: 29.1,
          sVal: 14,
          tVal: 6.8,
          series: [26.5, 27.1, 27.8, 28.3, 28.8, 29.1],
        },
        [MuleSensorDomain.CDFW_HABITAT_WATER_QUALITY]: {
          callsign: 'CDFW-4',
          pVal: waterTempC,
          sVal: 42,
          tVal: 9.9,
          series: [
            Number((waterTempC + 0.3).toFixed(1)),
            Number((waterTempC + 0.2).toFixed(1)),
            Number((waterTempC + 0.1).toFixed(1)),
            waterTempC,
            waterTempC,
            waterTempC,
          ],
        },
        [MuleSensorDomain.NRCS_ALPINE_SNOTEL]: {
          callsign: 'SNO-T8',
          pVal: -1.8,
          sVal: 74,
          tVal: 42.5,
          series: [-2.4, -2.2, -2.1, -2.0, -1.9, -1.8],
        },
      };

      const prof = domainProfiles[selectedHarvestDomain];
      const { bytes, envelope } = muleCollectorService.createAndIngestSensorHarvest(
        {
          stationCallsign: prof.callsign,
          sequenceNumber: seq,
          domain: selectedHarvestDomain,
          batteryPercent: 92,
          solarCharging: true,
          tamperAlert: false,
          thresholdExceeded: selectedHarvestDomain === MuleSensorDomain.USFS_WILDFIRE_RAWS,
          relativeAgeSeconds: 45,
          lat: effectiveCoords.lat,
          lon: effectiveCoords.lng,
          elevationMeters: canyonTrilateration.estimatedElevationMetersAsl || 850,
          primaryValue: prof.pVal,
          secondaryValue: prof.sVal,
          tertiaryValue: prof.tVal,
          stepIntervalMinutes: 15,
          historicalPrimarySeries: prof.series,
        },
        localIdentity?.nodeHexId || '!localMule'
      );

      const txRes = await meshtasticRadioService.sendMuleBinaryFrame(
        bytes,
        `[0xA1:${envelope.dedupKey}|MAC:${envelope.decoded.computedMacHex}]`
      );
      setPacketHistory(meshtasticRadioService.getPacketHistory());
      setCollectorStatusMsg(
        txRes.sentOverRf
          ? `32B Sensor Frame (${envelope.dedupKey}) signed [SipHash ${envelope.decoded.computedMacHex}] & transmitted on 915 MHz LoRa!`
          : `32B Sensor Frame (${envelope.dedupKey}) signed [SipHash ${envelope.decoded.computedMacHex}] & queued in persistent IndexedDB Outbox.`
      );
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to encode/harvest 32B sensor frame.');
    } finally {
      setIsTransmitting(false);
    }
  };

  const handleBroadcastRidgeEphemeris = async () => {
    setErrorMessage(null);
    setCollectorStatusMsg(null);
    setIsTransmitting(true);
    try {
      const seq = Math.floor((Date.now() / 1000) % 60000) + 1;
      const baseFlow = Math.max(25, Math.round(effectiveFlowCfs));
      const waterTempC = Number((((effectiveWaterTemp - 32) * 5) / 9).toFixed(1));
      const series24h = Array.from({ length: 12 }, (_, idx) => {
        const wave = Math.sin((idx / 11) * Math.PI) * (baseFlow * 0.12);
        return Math.round(baseFlow - baseFlow * 0.05 + wave);
      });

      const { bytes, ephemeris } = muleCollectorService.createAndIngestRidgeEphemeris(
        {
          gaugeId: currentLocation?.usgsStationId || '11264500',
          sequenceNumber: seq,
          waterTempC,
          seaLevelPressureHpa: currentLocation?.barometerHpa ?? 1016.2,
          pressureDelta3hHpa: currentLocation?.barometer3hDelta ?? -1.9,
          biteWindowScore: Math.round(effectiveBiteIndex * 10),
          nwsAlertCode: 1,
          dischargeCfs24hSeries: series24h,
        },
        localIdentity?.nodeHexId || '!ridgeMule'
      );

      const txRes = await meshtasticRadioService.sendMuleBinaryFrame(
        bytes,
        `[0xB2:${ephemeris.dedupKey}|FLOW:${baseFlow}CFS]`
      );
      setPacketHistory(meshtasticRadioService.getPacketHistory());
      setCollectorStatusMsg(
        txRes.sentOverRf
          ? `32B Ridge-Mule 24h USGS Hydrograph (${ephemeris.dedupKey}) broadcast over 915 MHz LoRa!`
          : `32B Ridge-Mule 24h USGS Hydrograph (${ephemeris.dedupKey}) staged & decoded in local canyon cache.`
      );
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to encode 32B Ridge-Mule Ephemeris frame.');
    } finally {
      setIsTransmitting(false);
    }
  };

  const handleSyncCollectorGateway = async () => {
    setIsSyncingCollector(true);
    setErrorMessage(null);
    setCollectorStatusMsg(null);
    try {
      const res = await muleCollectorService.syncWithGateway();
      setCollectorStatusMsg(
        `Gateway Sync Complete [${res.receiptId}]: ${res.ingestedCount} new frames ingested, ${res.deduplicatedCount} multi-mule witness records merged (${res.totalLedgerRecords} total verified in agency ledger).`
      );
    } catch (err: any) {
      setErrorMessage(err?.message || 'Collector gateway sync failed.');
    } finally {
      setIsSyncingCollector(false);
    }
  };

  const handleExportGeoJson = () => {
    const geojson = muleCollectorService.exportVerifiedHarvestsAsGeoJson();
    const blob = new Blob([geojson], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `meshmule-verified-telemetry-${new Date().toISOString().slice(0, 10)}.geojson`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportCsv = () => {
    const csv = muleCollectorService.exportVerifiedHarvestsAsCsv();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `meshmule-verified-telemetry-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleBroadcastGpsDeniedSarLocus = async () => {
    const sarPayload = `SAR_LOCUS|ALT:${canyonTrilateration.estimatedElevationFeetAsl}FT(+/-${canyonTrilateration.verticalUncertaintyFeet})|RF_FIX:${canyonTrilateration.estimatedLat.toFixed(4)}N,${Math.abs(canyonTrilateration.estimatedLon).toFixed(4)}W(+/-${canyonTrilateration.horizontalUncertaintyMeters}M)|BARO:${localStationBaroHpa}HPA`;
    if (connectionStatus !== 'disconnected') {
      await sendPayload(sarPayload);
    } else {
      const encoder = new TextEncoder();
      await meshtasticRadioService.sendMuleBinaryFrame(
        encoder.encode(sarPayload.padEnd(32, ' ').slice(0, 32)),
        sarPayload
      );
      setPacketHistory(meshtasticRadioService.getPacketHistory());
      setCollectorStatusMsg(
        `GPS-Denied Canyon SAR Locus staged: ${canyonTrilateration.estimatedElevationFeetAsl} ft ASL, [${canyonTrilateration.estimatedLat.toFixed(4)}, ${canyonTrilateration.estimatedLon.toFixed(4)}] (+/-${canyonTrilateration.horizontalUncertaintyMeters}m).`
      );
    }
  };

  const previewEncodedCustom = customMessage.trim() ? encodeAlertPacket(customMessage) : '';
  const activeCharCount = previewEncodedCustom ? previewEncodedCustom.length : 0;
  const isBudgetExceeded = customMessage.length > MAX_LORA_FRAME_BYTES;
  const peerNodesOnly = discoveredNodes.filter((n) => !n.isLocalNode);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-2.5 sm:p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-2xl border-2 border-[#00d2ff] bg-[#0b132b] text-white shadow-[0_24px_60px_rgba(0,0,0,0.85)] overflow-hidden flex flex-col max-h-[92vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-3.5 border-b-2 border-[#00d2ff] bg-[#0b2545]">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`w-3.5 h-3.5 rounded-full shrink-0 border border-white ${
                connectionStatus === 'disconnected'
                  ? 'bg-slate-400'
                  : 'bg-emerald-400 animate-pulse shadow-[0_0_10px_#34d399]'
              }`}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-sm sm:text-base font-mono font-black tracking-wider uppercase truncate text-white">
                  Off-Grid LoRa Mesh Communicator
                </h2>
                <span className="px-2 py-0.5 rounded text-[10px] font-mono font-black bg-[#ffb800] text-slate-950 border border-white">
                  Meshtastic 915 MHz
                </span>
              </div>
              <p className="text-[11px] font-mono text-sky-200 truncate">
                Waterway: <strong className="text-white">{effectiveWaterwayName}</strong> ({effectiveCoords.lat.toFixed(4)}°N, {Math.abs(effectiveCoords.lng).toFixed(4)}°W)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleToggleBellAlert}
              title="Send External Notification Bell (0x07) with outgoing packets"
              className={`px-2.5 py-1.5 rounded-lg border-2 transition cursor-pointer flex items-center gap-1 font-mono text-[10px] font-black ${
                bellAlertEnabled
                  ? 'bg-emerald-400 border-white text-slate-950 shadow-sm'
                  : 'bg-[#132a4a] border-sky-400/70 text-white hover:bg-[#1c3d6b]'
              }`}
            >
              {bellAlertEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{bellAlertEnabled ? 'BELL ON' : 'BELL OFF'}</span>
            </button>

            <button
              onClick={onClose}
              className="font-mono text-xs font-black px-3 py-1.5 rounded-lg border-2 border-white bg-[#ff1e56] hover:bg-rose-500 text-white transition cursor-pointer flex items-center gap-1 shadow-sm"
            >
              <X className="w-3.5 h-3.5" />
              <span>[ESC]</span>
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="px-4 sm:px-6 py-2.5 border-b border-sky-500/40 bg-[#081224] flex items-center justify-between gap-2 text-xs font-mono flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => setActiveTab('comms')}
              className={`px-3 py-1.5 rounded-lg font-black transition cursor-pointer flex items-center gap-1.5 border ${
                activeTab === 'comms'
                  ? 'bg-[#ffb800] text-slate-950 border-white shadow-[0_0_10px_rgba(255,184,0,0.45)]'
                  : 'bg-[#132a4a] text-white border-sky-400/60 hover:bg-[#1d3f6f]'
              }`}
            >
              <Radio className="w-3.5 h-3.5" />
              <span>Field Comms</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('mule')}
              className={`px-3 py-1.5 rounded-lg font-black transition cursor-pointer flex items-center gap-1.5 border ${
                activeTab === 'mule'
                  ? 'bg-[#ffb800] text-slate-950 border-white shadow-[0_0_10px_rgba(255,184,0,0.45)]'
                  : 'bg-emerald-950 text-white border-emerald-400 hover:bg-emerald-900'
              }`}
            >
              <Database className="w-3.5 h-3.5" />
              <span>MeshMule ({harvestEnvelopes.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('array')}
              className={`px-3 py-1.5 rounded-lg font-black transition cursor-pointer flex items-center gap-1.5 border ${
                activeTab === 'array'
                  ? 'bg-[#ffb800] text-slate-950 border-white shadow-[0_0_10px_rgba(255,184,0,0.45)]'
                  : 'bg-cyan-950 text-white border-[#00d2ff] hover:bg-cyan-900'
              }`}
            >
              <Compass className="w-3.5 h-3.5" />
              <span>Phased Array &amp; SAR</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('nodes')}
              className={`px-3 py-1.5 rounded-lg font-black transition cursor-pointer flex items-center gap-1.5 border ${
                activeTab === 'nodes'
                  ? 'bg-[#ffb800] text-slate-950 border-white shadow-[0_0_10px_rgba(255,184,0,0.45)]'
                  : 'bg-[#132a4a] text-white border-sky-400/60 hover:bg-[#1d3f6f]'
              }`}
            >
              <Users className="w-3.5 h-3.5" />
              <span>Mesh Nodes ({peerNodesOnly.length})</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab('diagnostics');
                if (connectionStatus !== 'disconnected') {
                  handleRefreshDiagnostics();
                }
              }}
              className={`px-3 py-1.5 rounded-lg font-black transition cursor-pointer flex items-center gap-1.5 border ${
                activeTab === 'diagnostics'
                  ? 'bg-[#ffb800] text-slate-950 border-white shadow-[0_0_10px_rgba(255,184,0,0.45)]'
                  : 'bg-[#132a4a] text-white border-sky-400/60 hover:bg-[#1d3f6f]'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              <span>Radio Status</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('rf_calc')}
              className={`px-3 py-1.5 rounded-lg font-black transition cursor-pointer flex items-center gap-1.5 border ${
                activeTab === 'rf_calc'
                  ? 'bg-[#ffb800] text-slate-950 border-white shadow-[0_0_10px_rgba(255,184,0,0.45)]'
                  : 'bg-[#132a4a] text-white border-sky-400/60 hover:bg-[#1d3f6f]'
              }`}
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>RF Horizon</span>
            </button>
          </div>

          <div className="hidden sm:flex items-center gap-1.5 text-[10px]">
            <span className="text-sky-200 font-bold">PROTOCOL:</span>
            <button
              type="button"
              onClick={handleToggleFramingMode}
              className="px-2.5 py-1 rounded border border-emerald-400 bg-emerald-950 text-white font-black hover:bg-emerald-900 cursor-pointer"
              title="Switch between Meshtastic Protobuf (0x94 0xC3) and Raw ASCII Serial"
            >
              {framingMode === 'meshtastic_protobuf' ? 'MESHTASTIC PROTO' : 'TEXTMSG / UART'}
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="p-4 sm:p-6 overflow-y-auto space-y-5 flex-1 font-sans">
          {/* Universal Hardware Connection Bar */}
          <div className="p-4 rounded-xl border-2 border-sky-500/50 bg-[#0d1b36] flex flex-col gap-3">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-mono font-bold text-sky-200 uppercase">
                  Transceiver Interface
                </div>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span
                    className={`inline-block w-2.5 h-2.5 rounded-full ${
                      connectionStatus === 'disconnected'
                        ? 'bg-slate-400'
                        : 'bg-emerald-400 shadow-[0_0_6px_#34d399]'
                    }`}
                  />
                  <span className="font-mono font-black uppercase text-xs sm:text-sm tracking-wide text-white">
                    {connectionStatus === 'disconnected'
                      ? 'No Radio Connected'
                      : `Connected // ${deviceName}`}
                  </span>
                  {localIdentity && (
                    <span className="px-2 py-0.5 rounded bg-emerald-400 border border-white text-slate-950 font-mono text-xs font-black">
                      NODE: _{localIdentity.shortSuffix}
                    </span>
                  )}
                </div>

                {/* RF Signal Quality Deck Meter */}
                {connectionStatus !== 'disconnected' && (
                  <div className="flex items-center gap-3 mt-2 text-[11px] font-mono flex-wrap">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sky-200 font-bold">RF LINK:</span>
                      <span
                        className={`font-black px-2 py-0.5 rounded text-[10px] border ${
                          signalQuality.rating === 'EXCELLENT'
                            ? 'bg-emerald-400 text-slate-950 border-white'
                            : signalQuality.rating === 'GOOD'
                            ? 'bg-[#00d2ff] text-slate-950 border-white'
                            : signalQuality.rating === 'FAIR'
                            ? 'bg-[#ffb800] text-slate-950 border-white'
                            : 'bg-[#ff1e56] text-white border-white'
                        }`}
                      >
                        {signalQuality.rating} ({signalQuality.qualityPct}%)
                      </span>
                    </div>

                    {signalQuality.rssiDbm !== null && (
                      <span className="text-emerald-300 font-black">
                        RSSI: {signalQuality.rssiDbm} dBm
                      </span>
                    )}

                    {signalQuality.snrDb !== null && (
                      <span className="text-[#ffb800] font-black">
                        SNR: {signalQuality.snrDb} dB
                      </span>
                    )}

                    <div className="w-20 bg-slate-900 border border-slate-700 h-2 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${
                          signalQuality.qualityPct >= 70
                            ? 'bg-emerald-400'
                            : signalQuality.qualityPct >= 40
                            ? 'bg-[#ffb800]'
                            : 'bg-[#ff1e56]'
                        }`}
                        style={{ width: `${signalQuality.qualityPct}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                {connectionStatus === 'disconnected' ? (
                  <>
                    <button
                      type="button"
                      onClick={handleConnectBLE}
                      className="px-3.5 py-2 text-xs font-mono font-black bg-emerald-400 hover:bg-emerald-300 border-2 border-white text-slate-950 rounded-lg transition cursor-pointer flex items-center gap-1.5 shadow-sm"
                    >
                      <Bluetooth className="w-3.5 h-3.5" />
                      <span>Bluetooth</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleConnectSerial}
                      className="px-3.5 py-2 text-xs font-mono font-black bg-[#00d2ff] hover:bg-cyan-300 border-2 border-white text-slate-950 rounded-lg transition cursor-pointer flex items-center gap-1.5 shadow-sm"
                    >
                      <Usb className="w-3.5 h-3.5" />
                      <span>USB-C Serial</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowWifiConfig((v) => !v)}
                      className="px-3.5 py-2 text-xs font-mono font-black bg-[#ffb800] hover:bg-amber-300 border-2 border-white text-slate-950 rounded-lg transition cursor-pointer flex items-center gap-1.5 shadow-sm"
                    >
                      <Wifi className="w-3.5 h-3.5" />
                      <span>Wi-Fi HTTP</span>
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={handleRefreshDiagnostics}
                      className="px-3 py-2 text-xs font-mono font-black bg-[#00d2ff] hover:bg-cyan-300 border-2 border-white text-slate-950 rounded-lg transition cursor-pointer flex items-center gap-1.5 shadow-sm"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingDiag ? 'animate-spin' : ''}`} />
                      <span>Sync Node</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleDisconnect}
                      className="px-3.5 py-2 text-xs font-mono font-black bg-[#ff1e56] hover:bg-rose-500 border-2 border-white text-white rounded-lg transition cursor-pointer shadow-sm"
                    >
                      Disconnect
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Region Unset / TX Standby Warning & One-Click Fix */}
            {connectionStatus !== 'disconnected' &&
              (diagnostics.regionCode === 0 || diagnostics.txEnabled === false) && (
                <div className="p-3 rounded-lg bg-amber-950 border-2 border-[#ffb800] text-white text-xs font-mono flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4 text-[#ffb800] shrink-0" />
                    <span>
                      <strong>Transmitter Inactive (Region UNSET):</strong> Radio firmware locks SX1262 LoRa transmission until the regulatory region is set.
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleUnlockUsRegion}
                    disabled={isUnlockingRegion}
                    className="px-3 py-1.5 rounded-lg bg-[#ffb800] hover:bg-amber-300 border-2 border-white text-slate-950 font-black text-xs cursor-pointer flex items-center gap-1.5 shrink-0"
                  >
                    <Activity className={`w-3.5 h-3.5 ${isUnlockingRegion ? 'animate-spin' : ''}`} />
                    <span>{isUnlockingRegion ? 'Configuring Radio...' : 'Set US 915 MHz & Unlock TX'}</span>
                  </button>
                </div>
              )}

            {/* Platform Hardware Guidance (iOS Safari vs. Bluefy vs. Laptop) */}
            {connectionStatus === 'disconnected' && platform.isIOS && !platform.hasWebBluetooth && (
              <div className="p-3 rounded-lg bg-[#081224] border-2 border-[#00d2ff] text-white text-xs font-mono space-y-1.5">
                <div className="font-black flex items-center gap-1.5 text-[#00d2ff]">
                  <Bluetooth className="w-4 h-4" />
                  <span>iPhone Field Testing Vector:</span>
                </div>
                <p className="text-[11px] text-slate-100 leading-relaxed">
                  Apple Safari restricts Web Bluetooth. To pair directly with your ESP32-S3 over Bluetooth from your iPhone, open this app inside the free <strong>Bluefy Browser</strong> on iOS. Alternatively, enable your ESP32-S3 Wi-Fi Hotspot and tap <strong>Wi-Fi HTTP</strong> above, or connect via laptop.
                </p>
              </div>
            )}

            {showWifiConfig && connectionStatus === 'disconnected' && (
              <div className="pt-2 border-t border-sky-500/30 flex items-center gap-2">
                <input
                  type="text"
                  value={wifiHostInput}
                  onChange={(e) => setWifiHostInput(e.target.value)}
                  placeholder="meshtastic.local or 192.168.4.1"
                  className="flex-1 bg-slate-950 border-2 border-sky-500/60 rounded-lg px-3 py-1.5 text-xs font-mono text-white outline-none focus:border-[#ffb800]"
                />
                <button
                  type="button"
                  onClick={handleConnectWifi}
                  className="px-3.5 py-1.5 rounded-lg bg-[#ffb800] hover:bg-amber-300 border-2 border-white text-slate-950 font-mono font-black text-xs cursor-pointer"
                >
                  Connect
                </button>
              </div>
            )}
          </div>

          {errorMessage && (
            <div className="bg-rose-950/70 border border-rose-500/50 p-3 rounded-xl text-rose-200 text-xs font-mono flex items-center justify-between gap-2 flex-wrap">
              <span>⚠ {errorMessage}</span>
              {isInsideIframe && (
                <a
                  href={window.location.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-2.5 py-1 rounded bg-amber-500 text-slate-950 text-[10px] font-bold flex items-center gap-1 shrink-0"
                >
                  <span>Open Full Browser Tab</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          )}

          {collectorStatusMsg && (
            <div className="bg-emerald-950/70 border border-emerald-500/50 p-3 rounded-xl text-emerald-200 text-xs font-mono flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{collectorStatusMsg}</span>
              </div>
              <button
                type="button"
                onClick={() => setCollectorStatusMsg(null)}
                className="px-2 py-0.5 rounded bg-slate-800 border border-slate-500 text-white hover:bg-slate-700 text-[10px] font-black cursor-pointer"
              >
                [X]
              </button>
            </div>
          )}

          {activeTab === 'mule' && (
            /* TAB: MeshMule 32-Byte Citizen-Science Data-Mule Outbox & Ridge-Mule Ephemeris */
            <div className="space-y-4 font-mono text-xs">
              {/* Zero-Identity Contributor Header & Gateway Sync Controls */}
              <div className="p-4 rounded-xl bg-slate-950 border-2 border-emerald-400/70 space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <div className="text-emerald-300 font-black uppercase text-sm flex items-center gap-2">
                      <Database className="w-4 h-4 text-emerald-400" />
                      <span>MeshMule Store-and-Forward Citizen-Science Outbox</span>
                    </div>
                    <div className="text-[11px] text-slate-200 mt-0.5">
                      Zero-Identity Contributor Token:{' '}
                      <strong className="text-emerald-300">{anonContributorToken}</strong> •
                      Auth: <strong className="text-[#00d2ff]">SipHash-2-4 (32-bit MAC)</strong> •
                      Persistence: <strong className="text-[#ffb800]">IndexedDB Offline Queue</strong>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button
                      type="button"
                      onClick={handleSyncCollectorGateway}
                      disabled={isSyncingCollector}
                      className="px-3 py-1.5 rounded-lg bg-emerald-400 hover:bg-emerald-300 disabled:opacity-40 border-2 border-white text-slate-950 font-black text-xs cursor-pointer flex items-center gap-1.5 shadow-sm"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isSyncingCollector ? 'animate-spin' : ''}`} />
                      <span>{isSyncingCollector ? 'Syncing Ledger...' : 'Sync Gateway Ledger'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleExportGeoJson}
                      className="px-3 py-1.5 rounded-lg bg-[#ffb800] hover:bg-amber-300 border-2 border-white text-slate-950 font-black text-[11px] cursor-pointer flex items-center gap-1 shadow-sm"
                      title="Export RFC 7946 GeoJSON for USGS / NPS / USFS GIS ingestion"
                    >
                      <Download className="w-3 h-3" />
                      <span>GeoJSON</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleExportCsv}
                      className="px-3 py-1.5 rounded-lg bg-[#00d2ff] hover:bg-cyan-300 border-2 border-white text-slate-950 font-black text-[11px] cursor-pointer flex items-center gap-1 shadow-sm"
                      title="Export Flat Scientific CSV Time-Series"
                    >
                      <Download className="w-3 h-3" />
                      <span>CSV</span>
                    </button>
                  </div>
                </div>

                {/* Live 32-Byte 0xA1 Backcountry Sensor Harvester & LoRa Relay */}
                <div className="p-3 rounded-lg bg-[#0d1b36] border border-sky-400/50 space-y-2.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-[11px] font-black text-[#00d2ff] uppercase">
                      Outbound 0xA1 Backcountry Sensor Harvester (32-Byte Binary Frame)
                    </span>
                    <span className="text-[10px] text-sky-100">
                      Packs 6x10-bit Callsign + 24-bit Lat/Lon + 3 Metrics + 5 Delta Steps + 4B SipHash MAC
                    </span>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <select
                      value={selectedHarvestDomain}
                      onChange={(e) => setSelectedHarvestDomain(Number(e.target.value) as MuleSensorDomain)}
                      className="flex-1 bg-slate-950 border-2 border-sky-400/70 rounded-lg px-2.5 py-1.5 text-xs font-bold text-white outline-none focus:border-[#ffb800]"
                    >
                      <option value={MuleSensorDomain.NPS_GEOTHERMAL_SEISMIC}>
                        NPS Geothermal / Geyser Seismic Logger (Vent Temp + Radon/CO2 + Tremor RMS)
                      </option>
                      <option value={MuleSensorDomain.USGS_HYDRO_GAUGE}>
                        USGS Backcountry Streamflow Logger (Water Temp + Discharge CFS + DO mg/L)
                      </option>
                      <option value={MuleSensorDomain.USFS_WILDFIRE_RAWS}>
                        USFS Wildfire Fuel Moisture Logger (Canopy Temp + RH% + 10-Hr Fuel Moisture)
                      </option>
                      <option value={MuleSensorDomain.CDFW_HABITAT_WATER_QUALITY}>
                        CDFW Salmonid Thermal Refugia Logger (Pool Temp + Conductance + DO mg/L)
                      </option>
                      <option value={MuleSensorDomain.NRCS_ALPINE_SNOTEL}>
                        NRCS Alpine SNOTEL Pillow Logger (Air Temp + Snow Depth + SWE Inches)
                      </option>
                    </select>
                    <button
                      type="button"
                      onClick={handleHarvestAndRelaySensorFrame}
                      disabled={isTransmitting}
                      className="px-3.5 py-1.5 rounded-lg bg-[#00d2ff] hover:bg-cyan-300 disabled:opacity-40 border-2 border-white text-slate-950 font-black text-xs cursor-pointer flex items-center justify-center gap-1.5 shrink-0 shadow-sm"
                    >
                      <Send className="w-3.5 h-3.5" />
                      <span>Harvest &amp; Relay 32B Sensor Frame (0xA1)</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Inbound 0xB2 Ridge-Mule 24-Hour USGS Hydrograph & Ephemeris Card */}
              {latestRidgeEphemeris && (
                <div className="p-4 rounded-xl bg-slate-950 border-2 border-[#00d2ff] space-y-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div>
                      <div className="text-[#00d2ff] font-black uppercase text-xs flex items-center gap-2">
                        <Activity className="w-4 h-4" />
                        <span>
                          Inbound 0xB2 Ridge-Mule 24h USGS Hydrograph &amp; Ephemeris (32B Frame)
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-200 mt-0.5">
                        USGS Gauge:{' '}
                        <strong className="text-white">#{latestRidgeEphemeris.decoded.gaugeId}</strong>{' '}
                        • Seq: #{latestRidgeEphemeris.decoded.sequenceNumber} • Bite Score:{' '}
                        <strong className="text-emerald-400">
                          {latestRidgeEphemeris.decoded.biteWindowScore}/100
                        </strong>{' '}
                        • Baro: {latestRidgeEphemeris.decoded.seaLevelPressureHpa} hPa (
                        {latestRidgeEphemeris.decoded.pressureDelta3hHpa >= 0 ? '+' : ''}
                        {latestRidgeEphemeris.decoded.pressureDelta3hHpa} hPa/3h)
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={handleBroadcastRidgeEphemeris}
                      disabled={isTransmitting}
                      className="px-3.5 py-1.5 rounded-lg bg-emerald-400 hover:bg-emerald-300 border-2 border-white text-slate-950 font-black text-[11px] cursor-pointer flex items-center gap-1.5 shadow-sm"
                    >
                      <Radio className="w-3.5 h-3.5" />
                      <span>Broadcast 32B Ridge Hydrograph (0xB2)</span>
                    </button>
                  </div>

                  {/* Reconstructed 12-Point (24-Hour) Canyon Flow Hydrograph Spark-Bars */}
                  <div className="p-3 rounded-lg bg-[#0d1b36] border border-sky-500/40 space-y-2">
                    <div className="flex items-center justify-between text-[10px] text-sky-100">
                      <span>
                        RECONSTRUCTED 24-HOUR CANYON HYDROGRAPH (12 x 4-BIT NIBBLES,{' '}
                        {latestRidgeEphemeris.decoded.minDischargeCfs}–
                        {latestRidgeEphemeris.decoded.maxDischargeCfs} CFS)
                      </span>
                      <span className="px-2 py-0.5 rounded bg-emerald-400 text-slate-950 font-black flex items-center gap-1">
                        <Lock className="w-3 h-3" />
                        MAC {latestRidgeEphemeris.decoded.computedMacHex} VERIFIED
                      </span>
                    </div>
                    <div className="grid grid-cols-12 gap-1 items-end h-16 pt-2">
                      {latestRidgeEphemeris.decoded.reconstructed24hSeries.map((pt, i) => {
                        const minF = latestRidgeEphemeris.decoded.minDischargeCfs;
                        const maxF = Math.max(
                          minF + 10,
                          latestRidgeEphemeris.decoded.maxDischargeCfs
                        );
                        const pct = Math.max(18, Math.round(((pt.dischargeCfs - minF) / (maxF - minF)) * 100));
                        return (
                          <div key={i} className="flex flex-col items-center gap-1">
                            <div className="text-[9px] text-[#00d2ff] font-black">
                              {pt.dischargeCfs}
                            </div>
                            <div className="w-full bg-slate-900 rounded-t h-10 flex items-end overflow-hidden border border-slate-700">
                              <div
                                className="w-full bg-[#00d2ff] rounded-t transition-all"
                                style={{ height: `${pct}%` }}
                              />
                            </div>
                            <div className="text-[8px] text-slate-300">-{22 - i * 2}h</div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="text-[10px] text-sky-200 truncate">
                      32B WIRE HEX: <span className="text-white font-bold">{latestRidgeEphemeris.rawHex}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Verified Citizen-Science Sensor Harvest Queue */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-[11px] text-sky-200 font-bold uppercase">
                  <span>
                    Harvested Backcountry Sensor Envelopes ({harvestEnvelopes.length})
                  </span>
                  <span>Deduplicated by Station Callsign + Sequence #</span>
                </div>
                <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
                  {harvestEnvelopes.map((env) => {
                    const d = env.decoded;
                    return (
                      <div
                        key={env.dedupKey}
                        className="p-3 rounded-xl bg-slate-950 border border-sky-500/40 space-y-2"
                      >
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="px-2 py-0.5 rounded bg-emerald-400 border border-white text-slate-950 font-black text-xs">
                              {d.stationCallsign}
                            </span>
                            <span className="text-white font-black">{d.domainLabel}</span>
                            <span className="text-[10px] text-sky-200 font-bold">SEQ #{d.sequenceNumber}</span>
                            {d.thresholdExceeded && (
                              <span className="px-2 py-0.5 rounded bg-[#ff1e56] border border-white text-white text-[10px] font-black">
                                ⚠ THRESHOLD ALERT
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="px-2 py-0.5 rounded bg-cyan-950 border border-[#00d2ff] text-white text-[10px] font-black">
                              Witnesses: {env.witnessCount}
                            </span>
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-black border ${
                                d.macVerified
                                  ? 'bg-emerald-950 text-white border-emerald-400'
                                  : 'bg-[#ff1e56] text-white border-white'
                              }`}
                            >
                              {d.macVerified ? `MAC ${d.computedMacHex} ✓` : 'MAC INVALID'}
                            </span>
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-black border ${
                                env.syncStatus === 'SYNCED_TO_COLLECTOR'
                                  ? 'bg-emerald-400 text-slate-950 border-white'
                                  : 'bg-[#ffb800] text-slate-950 border-white'
                              }`}
                            >
                              {env.syncStatus === 'SYNCED_TO_COLLECTOR' ? 'GATEWAY SYNCED' : 'OFFLINE OUTBOX'}
                            </span>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <div className="p-2 rounded bg-[#0d1b36] border border-sky-500/40">
                            <div className="text-[10px] text-sky-200 font-bold">{d.primaryMetric.label}</div>
                            <div className="text-sm font-black text-emerald-400">
                              {d.primaryMetric.value} {d.primaryMetric.unit}
                            </div>
                          </div>
                          <div className="p-2 rounded bg-[#0d1b36] border border-sky-500/40">
                            <div className="text-[10px] text-sky-200 font-bold">{d.secondaryMetric.label}</div>
                            <div className="text-sm font-black text-[#00d2ff]">
                              {d.secondaryMetric.value} {d.secondaryMetric.unit}
                            </div>
                          </div>
                          <div className="p-2 rounded bg-[#0d1b36] border border-sky-500/40">
                            <div className="text-[10px] text-sky-200 font-bold">{d.tertiaryMetric.label}</div>
                            <div className="text-sm font-black text-[#ffb800]">
                              {d.tertiaryMetric.value} {d.tertiaryMetric.unit}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center justify-between text-[10px] text-slate-200 flex-wrap gap-2">
                          <span>
                            GPS: {d.lat.toFixed(4)}°N, {Math.abs(d.lon).toFixed(4)}°W ({d.elevationMeters}m ASL)
                          </span>
                          <span>
                            RTC Corrected Sample: {new Date(d.correctedSampleUtc).toLocaleTimeString()} (-
                            {d.relativeAgeSeconds}s age offset) • Batt: {d.batteryPercent}%
                          </span>
                        </div>
                        <div className="text-[10px] text-sky-200 truncate">
                          32B HEX: <span className="text-white font-bold">{env.rawHex}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'array' && (
            /* TAB: Distributed Barometric Phased-Array (\nabla P), GPS-Denied Canyon SAR & 915 MHz RF Tomography */
            <div className="space-y-4 font-mono text-xs">
              {/* 1. 2D Distributed Barometric Phased-Array Squall Solver */}
              <div className="p-4 rounded-xl bg-slate-950 border-2 border-emerald-400/70 space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <div className="text-emerald-300 font-black uppercase text-sm flex items-center gap-2">
                      <Compass className="w-4 h-4 text-emerald-400" />
                      <span>2D Distributed Barometric Phased-Array (&nabla;P Squall Solver)</span>
                    </div>
                    <div className="text-[11px] text-slate-200 mt-0.5">
                      Hypsometric sea-level pressure reduction (P&#8320;) + Ordinary Least Squares planar gradient across {phasedArraySolution.nodeCount} mesh nodes
                    </div>
                  </div>
                  <span className="px-2.5 py-1 rounded bg-emerald-400 border border-white text-slate-950 font-black text-[11px]">
                    {phasedArraySolution.regimeClassification}
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  <div className="p-2.5 rounded-lg bg-[#0d1b36] border border-sky-500/40">
                    <div className="text-[10px] text-sky-200 font-bold">|&nabla;P| GRADIENT SLOPE</div>
                    <div className="text-base font-black text-emerald-400 mt-0.5">
                      {phasedArraySolution.gradientMagnitudeHpaPer100Km} hPa/100km
                    </div>
                    <div className="text-[10px] text-slate-300">
                      dP/dx: {phasedArraySolution.gradientEastHpaPer100Km} • dP/dy: {phasedArraySolution.gradientNorthHpaPer100Km}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-[#0d1b36] border border-sky-500/40">
                    <div className="text-[10px] text-sky-200 font-bold">APPROACHING LOW AZIMUTH</div>
                    <div className="text-base font-black text-[#00d2ff] mt-0.5">
                      {phasedArraySolution.approachingLowBearingDeg}° ({phasedArraySolution.approachingLowCardinal})
                    </div>
                    <div className="text-[10px] text-slate-300">
                      Vector: -&nabla;P Trough Bearing
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-[#0d1b36] border border-sky-500/40">
                    <div className="text-[10px] text-sky-200 font-bold">SQUALL FRONT VELOCITY</div>
                    <div className="text-base font-black text-[#ffb800] mt-0.5">
                      {phasedArraySolution.estimatedFrontSpeedMph} mph
                    </div>
                    <div className="text-[10px] text-slate-300">
                      ETA: {phasedArraySolution.estimatedFrontEtaMinutes ? `~${phasedArraySolution.estimatedFrontEtaMinutes} min` : 'Stationary/Rising'}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-[#0d1b36] border border-sky-500/40">
                    <div className="text-[10px] text-sky-200 font-bold">ARRAY MEAN SEA-LEVEL P&#8320;</div>
                    <div className="text-base font-black text-white mt-0.5">
                      {phasedArraySolution.meanSeaLevelPressureHpa} hPa
                    </div>
                    <div className="text-[10px] text-slate-300">
                      3h ΔP: {phasedArraySolution.meanTrend3hHpa >= 0 ? '+' : ''}{phasedArraySolution.meanTrend3hHpa} hPa
                    </div>
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-emerald-950 border border-emerald-400 text-white text-[11px] leading-relaxed">
                  <strong className="text-emerald-300">Phased-Array Tactical Advisory:</strong> {phasedArraySolution.tacticalSummary}
                </div>
              </div>

              {/* 2. GPS-Denied Canyon Trilateration & Barometric Altimeter Contour Lock */}
              <div className="p-4 rounded-xl bg-slate-950 border-2 border-[#00d2ff] space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <div className="text-[#00d2ff] font-black uppercase text-sm flex items-center gap-2">
                      <Navigation className="w-4 h-4" />
                      <span>GPS-Denied Canyon Trilateration &amp; Barometric Contour Lock</span>
                    </div>
                    <div className="text-[11px] text-slate-200 mt-0.5">
                      Backup backcountry SAR positioning when satellite GNSS is lost, submerged, or occluded by granite walls
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleBroadcastGpsDeniedSarLocus}
                    disabled={isTransmitting}
                    className="px-3.5 py-1.5 rounded-lg bg-[#ffb800] hover:bg-amber-300 border-2 border-white text-slate-950 font-black text-xs cursor-pointer flex items-center gap-1.5 shadow-sm"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Broadcast SAR Locus</span>
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="p-3 rounded-lg bg-[#0d1b36] border border-sky-500/40 space-y-2">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-sky-200 font-bold">Local Raw Station Barometer:</span>
                      <span className="text-emerald-400 font-black">{localStationBaroHpa.toFixed(1)} hPa</span>
                    </div>
                    <input
                      type="range"
                      min="780"
                      max="1015"
                      step="0.5"
                      value={localStationBaroHpa}
                      onChange={(e) => setLocalStationBaroHpa(parseFloat(e.target.value))}
                      className="w-full accent-emerald-400"
                    />
                    <div className="flex justify-between text-[11px] pt-1">
                      <span className="text-sky-200 font-bold">Local Canyon Air Temp:</span>
                      <span className="text-[#00d2ff] font-black">{localAmbientTempC.toFixed(1)} °C</span>
                    </div>
                    <input
                      type="range"
                      min="-5"
                      max="38"
                      step="0.5"
                      value={localAmbientTempC}
                      onChange={(e) => setLocalAmbientTempC(parseFloat(e.target.value))}
                      className="w-full accent-cyan-400"
                    />
                  </div>

                  <div className="p-3 rounded-lg bg-[#0d1b36] border border-sky-500/40 space-y-1.5">
                    <div className="text-[10px] text-sky-200 font-bold uppercase">
                      SOLVED 3D BACKCOUNTRY POSITION ({canyonTrilateration.mode})
                    </div>
                    <div className="text-base font-black text-emerald-400">
                      Contour Elevation: {canyonTrilateration.estimatedElevationFeetAsl} ft ASL{' '}
                      <span className="text-xs text-slate-200">
                        ({canyonTrilateration.estimatedElevationMetersAsl}m ±{canyonTrilateration.verticalUncertaintyFeet}ft)
                      </span>
                    </div>
                    <div className="text-sm font-black text-[#00d2ff]">
                      915 MHz RF Locus: {canyonTrilateration.estimatedLat.toFixed(5)}°N,{' '}
                      {Math.abs(canyonTrilateration.estimatedLon).toFixed(5)}°W
                    </div>
                    <div className="text-[11px] text-[#ffb800] font-bold">
                      Horizontal 95% CEP Uncertainty: ±{canyonTrilateration.horizontalUncertaintyMeters}m across{' '}
                      {canyonTrilateration.anchorDetails.length} RF anchors
                    </div>
                  </div>
                </div>

                <div className="text-[11px] text-white bg-[#0d1b36] p-2.5 rounded-lg border border-sky-500/40">
                  {canyonTrilateration.advisory}
                </div>
              </div>

              {/* 3. Passive 915 MHz RF Link-Budget Atmospheric Tomography */}
              <div className="p-4 rounded-xl bg-slate-950 border-2 border-[#ffb800] space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <div className="text-[#ffb800] font-black uppercase text-sm flex items-center gap-2">
                      <Activity className="w-4 h-4" />
                      <span>Passive 915 MHz RF Link Atmospheric Tomography</span>
                    </div>
                    <div className="text-[11px] text-slate-200 mt-0.5">
                      Bistatic Friis Free-Space Path Loss (FSPL) vs. Measured LoRa RSSI/SNR Refractivity Solver
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="px-2.5 py-0.5 rounded bg-[#ffb800] border border-white text-slate-950 font-black text-[10px]">
                      Mean K-Factor: {rfTomographyReport.meanKFactor}
                    </span>
                    <span className="px-2.5 py-0.5 rounded bg-[#00d2ff] border border-white text-slate-950 font-black text-[10px]">
                      N = {rfTomographyReport.meanRefractivityN} N-units
                    </span>
                  </div>
                </div>

                <div className="p-2.5 rounded-lg bg-[#0d1b36] border border-sky-500/40 text-[11px] text-white">
                  {rfTomographyReport.basinSummary}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {rfTomographyReport.chords.slice(0, 4).map((chord) => (
                    <div
                      key={chord.nodeId}
                      className="p-2.5 rounded-lg bg-[#0d1b36] border border-sky-500/40 space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-black text-white">
                          Chord &rarr; {chord.callsign} ({chord.distanceKm.toFixed(2)} km)
                        </span>
                        <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-400 text-slate-950 font-black">
                          K = {chord.estimatedKFactor}
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-200">
                        FSPL: {chord.theoreticalFsplDb} dB • Measured: {chord.measuredPathLossDb} dB •{' '}
                        <strong className="text-[#ffb800]">Excess ΔL: +{chord.excessLossDb} dB</strong>
                      </div>
                      <div className="text-[10px] text-[#00d2ff] font-bold">{chord.ecologicalImplication}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'comms' && (
            <>
              {/* 1-Tap Field Broadcasts */}
              <div className="space-y-2.5">
                <label className="text-xs font-mono font-bold text-sky-200 uppercase tracking-wider block">
                  1-Tap Tactical Mesh Broadcasts
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={handleSendBiteTelemetry}
                    disabled={connectionStatus === 'disconnected' || isTransmitting}
                    className="p-3.5 bg-[#0d1b36] hover:bg-[#162d57] disabled:opacity-50 border-2 border-emerald-400 rounded-xl text-left transition group cursor-pointer shadow-sm"
                  >
                    <div className="text-xs font-mono font-black text-white flex items-center justify-between">
                      <span className="flex items-center gap-1.5">
                        <span className="px-1.5 py-0.5 rounded bg-emerald-400 text-slate-950 text-[10px] font-black">
                          TX
                        </span>
                        <span>Broadcast Bite &amp; Solunar Report</span>
                      </span>
                      <Send className="w-3.5 h-3.5 text-emerald-400" />
                    </div>
                    <div className="text-[11px] text-sky-100 mt-1.5 font-mono truncate">
                      TEMP:{Math.round(effectiveWaterTemp)}F| SOL:{effectiveSolunar}| BITE_INDEX:{effectiveBiteIndex.toFixed(1)}| FLOW:{effectiveFlowCfs}CFS
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={handleSendNavigation}
                    disabled={connectionStatus === 'disconnected' || isTransmitting}
                    className="p-3.5 bg-[#0d1b36] hover:bg-[#162d57] disabled:opacity-50 border-2 border-[#00d2ff] rounded-xl text-left transition group cursor-pointer shadow-sm"
                  >
                    <div className="text-xs font-mono font-black text-white flex items-center justify-between">
                      <span className="flex items-center gap-1.5">
                        <span className="px-1.5 py-0.5 rounded bg-[#00d2ff] text-slate-950 text-[10px] font-black">
                          WPT
                        </span>
                        <span>Share GPS Waypoint</span>
                      </span>
                      <MapPin className="w-3.5 h-3.5 text-[#00d2ff]" />
                    </div>
                    <div className="text-[11px] text-sky-100 mt-1.5 font-mono truncate">
                      WPT:{effectiveCoords.lat.toFixed(3)}N,{Math.abs(effectiveCoords.lng).toFixed(3)}W| MSG:{effectiveWaterwayName.slice(0, 18).toUpperCase()}
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={handleSendRangePing}
                    disabled={connectionStatus === 'disconnected' || isTransmitting}
                    className="p-3.5 bg-[#0d1b36] hover:bg-[#162d57] disabled:opacity-50 border-2 border-[#ffb800] rounded-xl text-left transition group cursor-pointer shadow-sm"
                  >
                    <div className="text-xs font-mono font-black text-white flex items-center justify-between">
                      <span className="flex items-center gap-1.5">
                        <span className="px-1.5 py-0.5 rounded bg-[#ffb800] text-slate-950 text-[10px] font-black">
                          PING
                        </span>
                        <span>Send Mesh Range Ping</span>
                      </span>
                      <Wifi className="w-3.5 h-3.5 text-[#ffb800]" />
                    </div>
                    <div className="text-[11px] text-sky-100 mt-1.5 font-mono truncate">
                      Verify link quality and delivery ACK across mesh channel
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={handleSendSos}
                    disabled={connectionStatus === 'disconnected' || isTransmitting}
                    className="p-3.5 bg-rose-950 hover:bg-rose-900 disabled:opacity-50 border-2 border-[#ff1e56] rounded-xl text-left transition group cursor-pointer shadow-sm"
                  >
                    <div className="text-xs font-mono font-black text-white flex items-center justify-between">
                      <span className="flex items-center gap-1.5">
                        <span className="px-1.5 py-0.5 rounded bg-[#ff1e56] text-white border border-white text-[10px] font-black">
                          SOS
                        </span>
                        <span>Transmit Emergency SOS</span>
                      </span>
                      <ShieldAlert className="w-3.5 h-3.5 text-white" />
                    </div>
                    <div className="text-[11px] text-rose-100 mt-1.5 font-mono truncate">
                      MSG:SOS_DISTRESS| WPT:{effectiveCoords.lat.toFixed(4)}N,{Math.abs(effectiveCoords.lng).toFixed(4)}W
                    </div>
                  </button>
                </div>
              </div>

              {/* Custom Message Composer */}
              <div className="space-y-2">
                <div className="flex justify-between items-center text-xs font-mono font-bold text-sky-200">
                  <span className="uppercase">Custom Field Message</span>
                  <span className={isBudgetExceeded ? 'text-rose-400 font-black' : 'text-emerald-400 font-black'}>
                    {activeCharCount} / {MAX_LORA_FRAME_BYTES} BYTES
                  </span>
                </div>

                <div className="flex gap-2">
                  <input
                    type="text"
                    value={customMessage}
                    onChange={(e) => setCustomMessage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSendCustomMessage();
                    }}
                    placeholder="Send message or report to mesh channel..."
                    className="flex-1 bg-slate-950 border-2 border-sky-500/60 text-white placeholder-slate-400 focus:border-[#ffb800] rounded-xl px-3 py-2 text-xs sm:text-sm font-mono outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleSendCustomMessage}
                    disabled={connectionStatus === 'disconnected' || !customMessage.trim() || isTransmitting}
                    className="px-4 py-2 bg-emerald-400 hover:bg-emerald-300 disabled:opacity-40 border-2 border-white text-slate-950 font-mono font-black text-xs rounded-xl transition cursor-pointer shrink-0 shadow-sm"
                  >
                    {isTransmitting ? 'Sending...' : 'Send'}
                  </button>
                </div>

                <div className="w-full bg-slate-900 border border-slate-700 h-2 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      isBudgetExceeded ? 'bg-[#ff1e56]' : 'bg-emerald-400'
                    }`}
                    style={{ width: `${Math.min(100, (activeCharCount / MAX_LORA_FRAME_BYTES) * 100)}%` }}
                  />
                </div>

                <div className="p-2.5 rounded-lg bg-slate-950 border border-sky-500/40 flex items-center justify-between gap-2 text-[10px] font-mono">
                  <span className="text-sky-200 font-bold flex items-center gap-1 shrink-0">
                    <Cpu className="w-3 h-3 text-emerald-400" />
                    <span>16B BINARY TELEMETRY FRAME:</span>
                  </span>
                  <span className="text-emerald-300 font-bold truncate">{compactBinaryHex}</span>
                </div>
              </div>

              {/* Live Mesh Packet Feed */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-mono font-bold text-sky-200 uppercase tracking-wider">
                  <span>Live Mesh Traffic Log ({packetHistory.length})</span>
                  {packetHistory.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setPacketHistory([])}
                      className="px-2 py-0.5 rounded bg-slate-800 border border-slate-600 text-[10px] text-white hover:bg-slate-700 cursor-pointer"
                    >
                      Clear Log
                    </button>
                  )}
                </div>
                <div className="bg-slate-950 p-3 rounded-xl border border-sky-500/40 h-44 overflow-y-auto font-mono text-xs space-y-2">
                  {packetHistory.length === 0 ? (
                    <div className="text-slate-400 italic text-center py-8">
                      No mesh traffic recorded in this session yet.
                    </div>
                  ) : (
                    packetHistory.map((pkt) => {
                      const decoded = decodeRadioPacket(pkt.payload);
                      const isOutbound = pkt.direction === 'tx';

                      return (
                        <div
                          key={pkt.id}
                          className={`p-2.5 rounded-lg border ${
                            isOutbound
                              ? 'bg-[#0d1b36] border-[#00d2ff] text-white'
                              : 'bg-emerald-950/60 border-emerald-400 text-white'
                          }`}
                        >
                          <div className="flex justify-between items-center text-[10px] text-sky-200 mb-1 flex-wrap gap-1">
                            <span className="font-black">
                              {isOutbound ? `▲ TX [${pkt.sender}]` : `▼ RX [${pkt.sender}]`}
                            </span>
                            <div className="flex items-center gap-2">
                              {pkt.rssiDbm !== undefined && (
                                <span className="text-emerald-300 font-bold">RSSI: {pkt.rssiDbm} dBm</span>
                              )}
                              {pkt.snrDb !== undefined && (
                                <span className="text-[#ffb800] font-bold">SNR: {pkt.snrDb} dB</span>
                              )}
                              <span>{new Date(pkt.timestamp).toLocaleTimeString()}</span>
                            </div>
                          </div>
                          <div className="font-bold break-all text-xs text-white">{pkt.payload}</div>

                          {isOutbound && pkt.ackDetail && (
                            <div
                              className={`mt-1.5 text-[10px] px-2 py-1 rounded border font-black ${
                                pkt.ackState === 'ack_received'
                                  ? 'bg-emerald-950 border-emerald-400 text-emerald-200'
                                  : pkt.ackState === 'failed'
                                  ? 'bg-rose-950 border-rose-400 text-rose-200'
                                  : 'bg-slate-950 border-[#ffb800] text-[#ffb800]'
                              }`}
                            >
                              {pkt.ackState === 'ack_received'
                                ? `✓ ${pkt.ackDetail}`
                                : pkt.ackState === 'failed'
                                ? `⚠ ${pkt.ackDetail}`
                                : `⏳ ${pkt.ackDetail}`}
                            </div>
                          )}

                          {Object.keys(decoded.fields).length > 0 && (
                            <div className="text-[10px] text-slate-300 mt-1.5 flex flex-wrap gap-1.5">
                              <span className="px-2 py-0.5 rounded bg-emerald-400 text-slate-950 font-black">
                                {decoded.type} ({decoded.byteLength}B)
                              </span>
                              {Object.entries(decoded.fields).map(([k, v]) => (
                                <span
                                  key={k}
                                  className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-200"
                                >
                                  {k}: <strong className="text-white">{v}</strong>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </>
          )}

          {activeTab === 'diagnostics' && (
            /* TAB: Radio Transceiver Status & RF Config */
            <div className="space-y-4 font-mono text-xs">
              <div className="p-4 rounded-xl bg-slate-950 border border-sky-500/40 space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="text-emerald-400 font-black uppercase text-sm flex items-center gap-2">
                    <Activity className="w-4 h-4" />
                    <span>Connected Transceiver Telemetry</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleRefreshDiagnostics}
                    disabled={connectionStatus === 'disconnected'}
                    className="px-3.5 py-1.5 rounded-lg bg-emerald-400 hover:bg-emerald-300 disabled:opacity-40 border-2 border-white text-slate-950 font-black text-xs cursor-pointer flex items-center gap-1.5 shadow-sm"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingDiag ? 'animate-spin' : ''}`} />
                    <span>Refresh Telemetry</span>
                  </button>
                </div>

                {connectionStatus === 'disconnected' ? (
                  <div className="p-4 rounded-lg bg-[#0d1b36] border border-sky-500/40 text-slate-200">
                    Connect a Meshtastic transceiver via Bluetooth, USB-C, or Wi-Fi to inspect hardware RF parameters.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div className="p-3 rounded-lg bg-[#0d1b36] border border-sky-500/40 space-y-1">
                      <div className="text-[10px] text-sky-200 font-bold">NODE IDENTITY</div>
                      <div className="text-sm font-black text-emerald-400">
                        _{diagnostics.shortSuffix} ({diagnostics.nodeHexId})
                      </div>
                      <div className="text-[11px] text-slate-200">
                        Firmware: {diagnostics.firmwareVersion || 'Meshtastic 2.x'} • Frames RX: {diagnostics.protoPacketsRxCount}
                      </div>
                    </div>

                    <div className="p-3 rounded-lg bg-[#0d1b36] border border-sky-500/40 space-y-1">
                      <div className="text-[10px] text-sky-200 font-bold">REGULATORY REGION &amp; TX STATE</div>
                      <div
                        className={`text-sm font-black ${
                          diagnostics.regionCode === 0 || diagnostics.txEnabled === false
                            ? 'text-rose-400'
                            : 'text-emerald-400'
                        }`}
                      >
                        {diagnostics.regionName} • TX: {diagnostics.txEnabled === false ? 'DISABLED' : 'ENABLED'}
                      </div>
                      <div className="text-[11px] text-slate-200">
                        Hop Limit: {diagnostics.hopLimit ?? 3} • TX Power: {diagnostics.txPowerDbm ? `${diagnostics.txPowerDbm} dBm` : 'Auto Max'}
                      </div>
                    </div>

                    <div className="p-3 rounded-lg bg-[#0d1b36] border border-sky-500/40 space-y-1">
                      <div className="text-[10px] text-sky-200 font-bold">MODEM PRESET &amp; FREQUENCY SLOT</div>
                      <div className="text-sm font-black text-[#00d2ff]">
                        {diagnostics.modemPresetName}
                      </div>
                      <div className="text-[11px] text-[#ffb800]">
                        Frequency Slot: <strong>{diagnostics.frequencySlot ?? 0}</strong>{' '}
                        {(diagnostics.frequencySlot ?? 0) === 0 ? '(Auto Hash)' : '(Manual Slot)'}
                      </div>
                    </div>

                    <div className="p-3 rounded-lg bg-[#0d1b36] border border-sky-500/40 space-y-1">
                      <div className="text-[10px] text-sky-200 font-bold">PRIMARY CHANNEL (CH0)</div>
                      <div className="text-sm font-black text-white">
                        Name: <span className="text-emerald-300">{diagnostics.primaryChannelName}</span>
                      </div>
                      <div className="text-[11px] text-slate-200">
                        Key (PSK): <strong className="text-[#ffb800]">{diagnostics.primaryChannelPskHex}</strong>
                      </div>
                    </div>

                    <div className="sm:col-span-2 p-3 rounded-lg bg-[#0d1b36] border border-sky-500/40 space-y-1">
                      <div className="text-[10px] text-sky-200 font-bold">
                        LAST ROUTING / DELIVERY STATUS
                      </div>
                      <div
                        className={`text-xs font-black ${
                          diagnostics.lastRoutingStatus.includes('ACK_RECEIVED')
                            ? 'text-emerald-400'
                            : diagnostics.lastRoutingStatus.includes('MAX_RETRANSMIT') ||
                              diagnostics.lastRoutingStatus.includes('NO_')
                            ? 'text-rose-400'
                            : 'text-[#ffb800]'
                        }`}
                      >
                        {diagnostics.lastRoutingStatus}
                      </div>
                    </div>

                    {/* Radio Provisioning Actions */}
                    <div className="sm:col-span-2 p-3.5 rounded-lg bg-[#0d1b36] border-2 border-emerald-400 space-y-2">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div>
                          <div className="text-xs font-black text-emerald-300">
                            Automated Radio Calibration &amp; US 915 MHz Provisioning
                          </div>
                          <div className="text-[10px] text-slate-200">
                            Writes standard US region (902–928 MHz), TX Enabled, and default LongFast/LongTurbo Channel 0 directly to radio over {connectionStatus.toUpperCase()}.
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleUnlockUsRegion()}
                            disabled={isUnlockingRegion}
                            className="px-3.5 py-1.5 rounded-lg bg-emerald-400 hover:bg-emerald-300 disabled:opacity-40 border-2 border-white text-slate-950 font-black text-xs cursor-pointer flex items-center gap-1.5 shadow-sm"
                          >
                            <Activity className={`w-3.5 h-3.5 ${isUnlockingRegion ? 'animate-spin' : ''}`} />
                            <span>{isUnlockingRegion ? 'Provisioning...' : 'Apply US LongFast (Default)'}</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'nodes' && (
            /* TAB: Discovered Mesh Peers & Hardware GPS Sync */
            <div className="space-y-4 font-mono text-xs">
              <div className="p-4 rounded-xl bg-slate-950 border border-sky-500/40 flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <div className="text-emerald-400 font-black flex items-center gap-1.5">
                    <Navigation className="w-3.5 h-3.5" />
                    <span>Hardware GPS Coordinate Sync</span>
                  </div>
                  <div className="text-[11px] text-slate-200 mt-0.5">
                    {hardwareGpsFix
                      ? `Active Radio GPS Fix: ${hardwareGpsFix.latitude.toFixed(5)}°N, ${Math.abs(hardwareGpsFix.longitude).toFixed(5)}°W (${hardwareGpsFix.sourceNode})`
                      : 'Synchronizes forecast coordinates with the connected transceiver GPS receiver.'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setUseRadioGps((v) => !v)}
                  className={`px-3.5 py-1.5 rounded-lg border-2 font-black text-xs cursor-pointer ${
                    useRadioGps
                      ? 'bg-emerald-400 border-white text-slate-950'
                      : 'bg-[#132a4a] border-sky-400/60 text-white hover:bg-[#1b3c69]'
                  }`}
                >
                  {useRadioGps ? 'RADIO GPS ON' : 'RADIO GPS OFF'}
                </button>
              </div>

              <div className="p-4 rounded-xl bg-slate-950 border border-sky-500/40 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-emerald-400 font-black uppercase flex items-center gap-2">
                    <Users className="w-4 h-4" />
                    <span>Discovered Mesh Nodes ({discoveredNodes.length})</span>
                  </span>
                </div>

                {discoveredNodes.length === 0 ? (
                  <div className="text-slate-400 italic text-center py-8">
                    No mesh nodes discovered yet.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {discoveredNodes.map((node) => (
                      <div
                        key={node.id}
                        className={`p-3 rounded-xl border flex items-center justify-between gap-3 flex-wrap ${
                          node.isLocalNode
                            ? 'bg-[#0d1b36] border-2 border-[#00d2ff]'
                            : 'bg-slate-900 border border-slate-700'
                        }`}
                      >
                        <div>
                          <div className="font-black text-white flex items-center gap-2">
                            <span>{node.longName}</span>
                            <span className="px-2 py-0.5 rounded bg-emerald-400 text-slate-950 font-black text-[10px]">
                              _{node.shortName}
                            </span>
                            {node.isLocalNode && (
                              <span className="px-2 py-0.5 rounded bg-[#00d2ff] text-slate-950 font-black text-[10px]">
                                LOCAL NODE
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-200 mt-0.5">
                            ID: {node.id}
                            {node.snr !== undefined && (
                              <span className="ml-2 text-emerald-300 font-bold">SNR: {node.snr} dB</span>
                            )}
                            {node.hopsAway !== undefined && !node.isLocalNode && (
                              <span className="ml-2 text-[#ffb800] font-bold">Hops: {node.hopsAway}</span>
                            )}
                            {node.latitude !== undefined && node.longitude !== undefined && (
                              <span className="ml-2 text-[#00d2ff] font-bold">
                                GPS: {node.latitude.toFixed(4)}°N, {Math.abs(node.longitude).toFixed(4)}°W
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="text-right text-[10px] text-slate-200">
                          {node.batteryLevel !== undefined && (
                            <div className="text-emerald-400 font-black">BATT: {node.batteryLevel}%</div>
                          )}
                          <div>Seen {node.lastHeard.toLocaleTimeString()}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'rf_calc' && (
            /* TAB: 915 MHz Line-of-Sight Horizon & Fresnel Zone Calculator */
            <div className="space-y-4 font-mono text-xs">
              <div className="p-4 rounded-xl bg-slate-950 border border-sky-500/40 space-y-3">
                <div className="text-emerald-400 font-black uppercase flex items-center gap-2">
                  <Activity className="w-4 h-4" />
                  <span>915 MHz ISM Line-of-Sight &amp; Fresnel Zone Calculator</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="p-3 rounded-lg bg-[#0d1b36] border border-sky-500/40">
                    <div className="text-[10px] text-sky-200 font-bold">RADIO HORIZON</div>
                    <div className="text-lg font-black text-emerald-400 mt-0.5">
                      {lineOfSightMiles} mi ({lineOfSightKm.toFixed(1)} km)
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-[#0d1b36] border border-sky-500/40">
                    <div className="text-[10px] text-sky-200 font-bold">1ST FRESNEL CLEARANCE</div>
                    <div className="text-lg font-black text-[#00d2ff] mt-0.5">
                      {fresnelRadiusMeters} m radius
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-[#0d1b36] border border-sky-500/40">
                    <div className="text-[10px] text-sky-200 font-bold">US915 FREQUENCY</div>
                    <div className="text-lg font-black text-[#ffb800] mt-0.5">
                      {channelFreqMhz.toFixed(3)} MHz
                    </div>
                  </div>
                </div>

                <div className="space-y-3 pt-2">
                  <div>
                    <div className="flex justify-between text-[11px] mb-1">
                      <span className="text-slate-100 font-bold">Local Antenna Elevation (Above Water/Ground)</span>
                      <span className="text-emerald-400 font-black">{localAntennaMeters.toFixed(1)} m</span>
                    </div>
                    <input
                      type="range"
                      min="0.5"
                      max="30"
                      step="0.5"
                      value={localAntennaMeters}
                      onChange={(e) => setLocalAntennaMeters(parseFloat(e.target.value))}
                      className="w-full accent-emerald-400"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-[11px] mb-1">
                      <span className="text-slate-100 font-bold">Remote Node Antenna Elevation</span>
                      <span className="text-[#00d2ff] font-black">{remoteAntennaMeters.toFixed(1)} m</span>
                    </div>
                    <input
                      type="range"
                      min="0.5"
                      max="50"
                      step="0.5"
                      value={remoteAntennaMeters}
                      onChange={(e) => setRemoteAntennaMeters(parseFloat(e.target.value))}
                      className="w-full accent-cyan-400"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 sm:px-6 py-3 border-t-2 border-[#00d2ff] bg-[#0b2545] font-mono text-[11px] text-sky-100 font-bold flex flex-wrap justify-between items-center gap-2">
          <span>Universal Meshtastic Protocol (Bluetooth • USB-C • Wi-Fi)</span>
          <span>Single-Frame Budget: 160 Chars | 32B MeshMule Binary</span>
        </div>
      </div>
    </div>
  );
};
