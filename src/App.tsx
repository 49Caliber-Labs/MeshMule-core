import React, { useState } from 'react';
import { Radio, Compass, Database, ShieldCheck, Activity, MapPin } from 'lucide-react';
import { FisheryLocation } from './types';
import { TacticalRadioModal } from './components/TacticalRadioModal';

const REFERENCE_WILDERNESS_BASINS: FisheryLocation[] = [
  {
    id: 'yosemite-merced-canyon',
    name: 'Merced River Canyon // Yosemite NP (Happy Isles USGS #11264500)',
    region: 'Yosemite National Park, CA',
    state: 'CA',
    coordinates: { lat: 37.7316, lng: -119.5582 },
    usgsStationId: '11264500',
    waterTemp: 52,
    flowRate: '645 CFS',
    barometerHpa: 1015.4,
    barometer3hDelta: -2.1,
    elevationMeters: 1230,
  },
  {
    id: 'yellowstone-firehole',
    name: 'Firehole & Upper Geyser Basin // Yellowstone NP (USGS #06036905)',
    region: 'Yellowstone National Park, WY',
    state: 'WY',
    coordinates: { lat: 44.4605, lng: -110.8281 },
    usgsStationId: '06036905',
    waterTemp: 61,
    flowRate: '390 CFS',
    barometerHpa: 1018.2,
    barometer3hDelta: -1.4,
    elevationMeters: 2240,
  },
  {
    id: 'tahoe-truckee-alpine',
    name: 'Upper Truckee & Alpine SNOTEL Basin // Lake Tahoe (USGS #10336610)',
    region: 'Sierra Nevada Crest, CA',
    state: 'CA',
    coordinates: { lat: 38.9214, lng: -119.9912 },
    usgsStationId: '10336610',
    waterTemp: 47,
    flowRate: '285 CFS',
    barometerHpa: 1014.0,
    barometer3hDelta: -2.8,
    elevationMeters: 1905,
  },
  {
    id: 'trinity-klamath-corridor',
    name: 'Trinity Alps & Klamath Thermal Refugia Corridor (USGS #11525500)',
    region: 'Six Rivers / Trinity Alps Wilderness, CA',
    state: 'CA',
    coordinates: { lat: 40.7208, lng: -122.9425 },
    usgsStationId: '11525500',
    waterTemp: 55,
    flowRate: '1120 CFS',
    barometerHpa: 1016.8,
    barometer3hDelta: -0.9,
    elevationMeters: 540,
  },
  {
    id: 'olympic-hoh-rainforest',
    name: 'Hoh River Glacial Rainforest Basin // Olympic NP (USGS #12041200)',
    region: 'Olympic National Park, WA',
    state: 'WA',
    coordinates: { lat: 47.8082, lng: -124.2498 },
    usgsStationId: '12041200',
    waterTemp: 49,
    flowRate: '1840 CFS',
    barometerHpa: 1011.6,
    barometer3hDelta: -3.4,
    elevationMeters: 215,
  },
  {
    id: 'grand-canyon-phantom',
    name: 'Colorado River Inner Gorge // Phantom Ranch (USGS #09402500)',
    region: 'Grand Canyon National Park, AZ',
    state: 'AZ',
    coordinates: { lat: 36.0989, lng: -112.0953 },
    usgsStationId: '09402500',
    waterTemp: 54,
    flowRate: '9450 CFS',
    barometerHpa: 1013.9,
    barometer3hDelta: -1.7,
    elevationMeters: 750,
  },
];

export function App() {
  const [selectedBasin, setSelectedBasin] = useState<FisheryLocation>(
    REFERENCE_WILDERNESS_BASINS[0]
  );
  const [radioModalOpen, setRadioModalOpen] = useState<boolean>(true);
  const [syncedGpsNote, setSyncedGpsNote] = useState<string | null>(null);

  return (
    <div className="min-h-screen bg-[#070e1d] text-white flex flex-col">
      {/* Top Command Header */}
      <header className="bg-[#0b2545] border-b-2 border-[#00d2ff] px-4 sm:px-6 py-4 shadow-lg">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="w-11 h-11 rounded-xl bg-[#132a4a] border-2 border-[#ffb800] flex items-center justify-center shrink-0">
              <Radio className="w-6 h-6 text-[#ffb800]" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-lg sm:text-xl font-mono font-black tracking-wider uppercase text-white">
                  MeshMule-Core
                </h1>
                <span className="px-2 py-0.5 rounded bg-[#ffb800] text-slate-950 font-mono text-[10px] font-black border border-white">
                  v1.0.0 • 915 MHz DTN &amp; SAR
                </span>
                <span className="px-2 py-0.5 rounded bg-emerald-400 text-slate-950 font-mono text-[10px] font-black border border-white">
                  SipHash-2-4 Verified
                </span>
              </div>
              <p className="text-xs font-mono text-sky-200 mt-0.5">
                49Caliber Labs • Open-Source Off-Grid Citizen-Science Data-Mule, Barometric Phased-Array &amp; GPS-Denied SAR Engine
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={selectedBasin.id}
              onChange={(e) => {
                const found = REFERENCE_WILDERNESS_BASINS.find((b) => b.id === e.target.value);
                if (found) setSelectedBasin(found);
              }}
              className="bg-slate-950 border-2 border-[#00d2ff] rounded-xl px-3 py-2 text-xs font-mono font-bold text-white outline-none focus:border-[#ffb800]"
            >
              {REFERENCE_WILDERNESS_BASINS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => setRadioModalOpen(true)}
              className="px-4 py-2 rounded-xl bg-emerald-400 hover:bg-emerald-300 border-2 border-white text-slate-950 font-mono font-black text-xs cursor-pointer flex items-center gap-2 shadow-md"
            >
              <Radio className="w-4 h-4" />
              <span>Open MeshMule Transceiver Deck</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Overview & Architecture Deck (Visible when modal is minimized) */}
      <main className="max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 space-y-6 flex-1 font-mono">
        {syncedGpsNote && (
          <div className="p-3 rounded-xl bg-emerald-950 border-2 border-emerald-400 text-white text-xs flex items-center justify-between">
            <span className="flex items-center gap-2 font-bold">
              <MapPin className="w-4 h-4 text-emerald-400" />
              <span>{syncedGpsNote}</span>
            </span>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-5 rounded-2xl bg-[#0b132b] border-2 border-emerald-400 space-y-2">
            <div className="flex items-center gap-2 text-emerald-400 font-black text-sm uppercase">
              <Database className="w-4 h-4" />
              <span>0xA1 / 0xB2 32-Byte Wire Protocol</span>
            </div>
            <p className="text-xs text-slate-200 leading-relaxed">
              Sub-65ms 915 MHz LoRa binary frames packing 6x10-bit station callsigns, 24-bit fixed-point coordinates, 3 scientific telemetry channels, 5 historical delta steps, and a 32-bit keyed <strong>SipHash-2-4 MAC</strong>.
            </p>
          </div>

          <div className="p-5 rounded-2xl bg-[#0b132b] border-2 border-[#00d2ff] space-y-2">
            <div className="flex items-center gap-2 text-[#00d2ff] font-black text-sm uppercase">
              <Compass className="w-4 h-4" />
              <span>2D Barometric Phased-Array &amp; SAR</span>
            </div>
            <p className="text-xs text-slate-200 leading-relaxed">
              Hypsometric sea-level reduction (P&#8320;) and Ordinary Least Squares planar gradient (&nabla;P) squall solver paired with GPS-denied canyon trilateration (&pm;14 ft vertical barometric contour lock + 915 MHz RSSI Gauss-Newton solver).
            </p>
          </div>

          <div className="p-5 rounded-2xl bg-[#0b132b] border-2 border-[#ffb800] space-y-2">
            <div className="flex items-center gap-2 text-[#ffb800] font-black text-sm uppercase">
              <Activity className="w-4 h-4" />
              <span>Passive 915 MHz RF Tomography</span>
            </div>
            <p className="text-xs text-slate-200 leading-relaxed">
              Bistatic Friis Free-Space Path Loss (FSPL) vs. measured LoRa RSSI/SNR link-budget residual solver estimating boundary-layer refractivity (K-factor, ITU N-units) and over-water thermal inversion ducting.
            </p>
          </div>
        </div>

        <div className="p-6 rounded-2xl bg-[#0b2545] border-2 border-[#00d2ff] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-white font-black text-sm uppercase">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Active Basin: {selectedBasin.name}</span>
            </div>
            <div className="text-xs text-sky-200">
              Coordinates: {selectedBasin.coordinates.lat.toFixed(4)}°N, {Math.abs(selectedBasin.coordinates.lng).toFixed(4)}°W • Elevation: {selectedBasin.elevationMeters}m ASL • Reference USGS Gauge: #{selectedBasin.usgsStationId}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setRadioModalOpen(true)}
            className="px-5 py-2.5 rounded-xl bg-[#ffb800] hover:bg-amber-300 border-2 border-white text-slate-950 font-black text-xs cursor-pointer shrink-0"
          >
            Launch Transceiver &amp; Citizen-Science Outbox
          </button>
        </div>
      </main>

      <TacticalRadioModal
        isOpen={radioModalOpen}
        onClose={() => setRadioModalOpen(false)}
        currentLocation={selectedBasin}
        biteScore={84}
        solunarPeakLabel="MAJOR 14:15-16:15"
        highVisMode={true}
        onSyncHardwareGps={(lat, lng, nodeName) => {
          setSyncedGpsNote(
            `Hardware GPS synchronized from ${nodeName}: ${lat.toFixed(5)}°N, ${Math.abs(lng).toFixed(5)}°W`
          );
        }}
      />
    </div>
  );
}

export default App;
