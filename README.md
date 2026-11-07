<div align="center">
  <img src="https://raw.githubusercontent.com/49Caliber-Labs/.github/main/assets/meshmule-hero-banner.svg" alt="MeshMule-Core — 32-Byte Sub-GHz LoRa DTN Telemetry & Barometric Array Engine" width="100%" />

  <br />

  [![License: MIT](https://img.shields.io/badge/License-MIT-059669?style=for-the-badge)](LICENSE)
  [![RF Band](https://img.shields.io/badge/ISM_Band-868_%2F_915_MHz_LoRa-0284c7?style=for-the-badge)](#1-system-architecture--wire-protocol)
  [![Wire Frame](https://img.shields.io/badge/Wire_Protocol-32_Byte_Binary_(0xA1%2F0xB2)-d97706?style=for-the-badge)](#2-the-32-byte-binary-wire-protocol-0xa1--0xb2)
  [![Cryptographic Auth](https://img.shields.io/badge/Authentication-SipHash--2--4_MAC-0d9488?style=for-the-badge)](#3-cryptographic-anti-spoofing--rtc-clock-drift-calibration)
  [![Sponsor](https://img.shields.io/badge/Sponsor-49Caliber_Labs-e11d48?style=for-the-badge&logo=githubsponsors&logoColor=white)](https://github.com/J-O-E-L-T#-github-sponsors--research-grants-why-back-my-work)
</div>

> **Developed by [49Caliber Labs, Inc.](https://github.com/49Caliber-Labs) (Principal Architect: [Joel T.](https://github.com/J-O-E-L-T))**  
> *An open-source, pure-digital 868/915 MHz LoRa / Meshtastic delay-tolerant telemetry transport, distributed barometric phased-array ($\nabla P$), passive RF atmospheric tomography engine, and GPS-denied canyon search-and-rescue (SAR) positioning stack engineered for backcountry scientific data harvesting (USGS, NPS, USFS, NOAA, CDFW, NRCS, and EU INSPIRE).*

---

## 🧭 Executive Overview & Scientific Motivation

Remote environmental monitoring stations across National Parks, wilderness watersheds, and alpine basins (geothermal/seismic loggers, stream gauges, wildfire fuel-moisture sensors, and salmonid thermal refugia monitors) frequently operate in deep topographic shadows where cellular coverage is nonexistent and satellite telemetry ($30–$80/month per node via Iridium/GOES) is cost-prohibitive at high spatial density.

Simultaneously, thousands of hikers, anglers, backcountry rangers, and field researchers traverse these exact corridors carrying smartphones and low-power 915 MHz LoRa transceivers (ESP32-S3 / nRF52840).

**MeshMule-Core** transforms every opt-in wilderness traveler into an autonomous, zero-identity **Store-and-Forward Scientific Data Mule** while providing the traveler with **life-safety backcountry situational awareness**:

1. **Outbound Citizen-Science Harvesting (`0xA1` 32-Byte Frame):** As a traveler passes within 1–5 miles of an isolated solar sensor logger in a canyon or alpine basin, their radio silently harvests a **32-byte binary telemetry frame** (`<65 ms` LoRa airtime), verifies its **32-bit keyed SipHash-2-4 MAC**, calibrates battery-RTC clock drift against phone GPS UTC, stores it in a persistent **`IndexedDB` Offline Outbox**, and forwards it to the agency ledger the moment the traveler reaches trailhead Wi-Fi or cellular service.
2. **Inbound "Ridge-Mule" Hydrograph & Weather Ephemeris (`0xB2` 32-Byte Frame):** High-elevation ridge repeaters or hikers descending from cellular coverage broadcast compressed **24-hour USGS river discharge hydrographs (12 $\times$ 4-bit nibbles)**, barometric tendencies, and NWS flash-flood alerts down into dead-zone river canyons.
3. **2D Distributed Barometric Phased-Array ($\nabla P$):** Treats the ad-hoc mesh of peer transceivers as a synchronized meteorological array—normalizing raw station pressures to sea level ($P_0$) via the international hypsometric equation and solving a 2D Ordinary Least Squares (OLS) pressure plane to compute approaching squall-front bearing ($^\circ$) and velocity ($\text{mph}$) completely off-grid.
4. **GPS-Denied Canyon SAR Trilateration & Contour Lock:** When satellite GNSS is lost, submerged, or multipathed by sheer granite canyon walls, **MeshMule-Core** locks the operator's vertical elevation contour ($\pm 14\text{ ft}$) via the local barometric altimeter referenced against the peer array's $P_0$ plane, and solves horizontal 2D coordinates via a 12-iteration damped Gauss-Newton solver over 915 MHz LoRa RSSI/SNR link measurements.
5. **Passive 915 MHz RF Atmospheric Tomography:** Compares theoretical Friis Free-Space Path Loss ($FSPL$) against measured LoRa RSSI/SNR across known-coordinate peer nodes to invert atmospheric boundary-layer refractivity ($K$-factor, ITU $N$-units) and detect over-water thermal inversion ducting or wildfire smoke attenuation.

---

## 1. System Architecture & Wire Protocol

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                     REMOTE WILDERNESS SENSOR NODE (ESP32-S3 / nRF52840)                │
│  • NPS Geothermal / Seismic   • USGS Streamflow / Temp   • USFS RAWS Fuel Moisture     │
│  • CDFW Salmonid Refugia      • NRCS SNOTEL Snow Pillow  • 5-Year LiFePO4 + Solar      │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │ 915 MHz LoRa Broadcast (PORTNUM=256)
                                            │ 32-Byte Binary Frame (0xA1) • <65ms Airtime
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│               PEDESTRIAN DATA MULE (MeshMule-Core PWA + BLE / USB-C / Wi-Fi)           │
│  1. SipHash-2-4 (32-bit MAC) Verification    4. 2D Barometric Phased-Array (∇P)        │
│  2. RTC Relative-Age Drift Calibration       5. GPS-Denied Canyon SAR Trilateration    │
│  3. IndexedDB Store-and-Forward Outbox       6. Passive 915 MHz RF Link Tomography     │
└─────────────────────┬─────────────────────────────────────────────┬────────────────────┘
                      │ Inbound 0xB2 Frame (32B)                    │ Trailhead Cellular / Wi-Fi
                      ▼                                             ▼
┌───────────────────────────────────────────┐ ┌──────────────────────────────────────────┐
│   DEEP-CANYON TRAVELERS & SAR TEAMS       │ │   AGENCY COLLECTOR GATEWAY               │
│  • Reconstructed 24h USGS Flow Hydrograph │ │  • Multi-Mule Witness Deduplication      │
│  • NWS Flash-Flood & Squall Warnings      │ │  • Zero-Identity Token (MULE-XXXX-XXXX)  │
│  • GPS-Denied 3D SAR Locus Broadcast      │ │  • RFC 7946 GeoJSON & CSV Export API     │
└───────────────────────────────────────────┘ └──────────────────────────────────────────┘
```

---

## 2. The 32-Byte Binary Wire Protocol (`0xA1` & `0xB2`)

Standard JSON or ASCII strings consume 180–250 bytes, causing LoRa packet fragmentation, high collision rates, and rapid battery drain. [`src/mesh-core/muleCodec.ts`](src/mesh-core/muleCodec.ts) packs complete multi-sensor time-series envelopes into an exact **32-byte (256-bit) binary frame**:

### A. Outbound Citizen-Science Sensor Harvest Frame (`Magic = 0xA1`, 32 Bytes)

| Byte Offset | Field | Encoding / Bit Width | Range & Precision |
| :--- | :--- | :--- | :--- |
| `0` | **Magic Header** | `uint8` (`0xA1`) | Identifies MeshMule `v1` Sensor Harvest Frame |
| `1..3` | **Domain & Sequence** | `4-bit` Domain + `20-bit` Seq | 5 Agency Domains (`NPS`, `USGS`, `USFS`, `CDFW`, `NRCS`), `0..1,048,575` Seq |
| `4..8` | **Station Callsign** | `6 x 6-bit` Base-64 + `4-bit` Flags | 6-char station ID (e.g. `YOS-G1`, `MRC-H4`) + Solar/Tamper/Alert flags |
| `9` | **Battery & Step** | `7-bit` Battery % + `1-bit` Step | `0..100%` LiFePO4 State of Charge; `15m` or `30m` historical delta interval |
| `10..11` | **RTC Relative Age** | `uint16` (Big-Endian) | Seconds elapsed (`0..65,535s`) between sensor sample and LoRa TX |
| `12..14` | **Latitude** | `int24` Fixed-Point | $[-90^\circ, +90^\circ]$ at $\approx 1.1\text{ m}$ spatial resolution |
| `15..17` | **Longitude** | `int24` Fixed-Point | $[-180^\circ, +180^\circ]$ at $\approx 2.2\text{ m}$ spatial resolution |
| `18..19` | **Elevation ASL** | `uint16` | $-500\text{ m}$ to $+6,053\text{ m}$ ASL ($0.1\text{ m}$ internal scaling) |
| `20..24` | **3-Channel Telemetry** | `14-bit` Pri + `14-bit` Sec + `12-bit` Ter | Domain-scaled primary, secondary, and tertiary scientific metrics |
| `25..27` | **5-Step Time-Series** | `5 x 4-bit` Signed Deltas | Reconstructs 6-point historical curve over the past $1.25\text{–}2.5\text{ hours}$ |
| `28..31` | **SipHash-2-4 MAC** | `uint32` (Big-Endian) | 32-bit keyed cryptographic message authentication code over Bytes `0..27` |

### B. Inbound "Ridge-Mule" 24-Hour USGS Hydrograph & Ephemeris (`Magic = 0xB2`, 32 Bytes)

| Byte Offset | Field | Encoding / Bit Width | Purpose |
| :--- | :--- | :--- | :--- |
| `0` | **Magic Header** | `uint8` (`0xB2`) | Identifies Ridge-Mule Canyon Ephemeris Broadcast |
| `1..4` | **USGS Gauge ID** | `uint32` | 8-digit USGS Station Number (e.g., `11264500` Merced River at Happy Isles) |
| `5..6` | **Sequence Number** | `uint16` | Rolling broadcast sequence ID for canyon deduplication |
| `7..8` | **Relative Age (s)** | `uint16` | Age in seconds since the ridge mule fetched the live USGS/NOAA feed |
| `9..13` | **Met/Hydro Snapshot** | `WaterTemp`, `P0`, `ΔP_3h`, `BiteScore`, `NWS` | Instantaneous canyon environmental & flash-flood alert vector |
| `14..17` | **Hydrograph Bounds** | `uint16` Min CFS + `uint16` Max CFS | 24-hour discharge envelope bounds ($0..65,535\text{ CFS}$) |
| `18..23` | **24h Curve Nibbles** | `12 x 4-bit` Quantized Nibbles | 12 two-hour discharge steps reconstructing the full 24-hour river hydrograph |
| `24..27` | **Reserved / CRC** | `uint32` | Ephemeris integrity & hop metadata |
| `28..31` | **SipHash-2-4 MAC** | `uint32` | 32-bit keyed cryptographic authentication tag over Bytes `0..27` |

---

## 3. Cryptographic Anti-Spoofing & RTC Clock-Drift Calibration

- **Keyed SipHash-2-4 (32-Bit Truncated MAC):** Every 32-byte `0xA1` and `0xB2` frame is authenticated in [`src/mesh-core/muleCodec.ts`](src/mesh-core/muleCodec.ts) using a pure-TypeScript 64-bit ARX (Add-Rotate-XOR) **SipHash-2-4** implementation truncated to 32 bits (`Bytes 28..31`). Corrupted or unauthenticated frames are rejected at both the mobile outbox and the `/__telemetry/mule-collector` agency gateway.
- **Zero-RTC Clock-Drift Correction:** Remote wilderness sensors lack GPS Disciplined Oscillators (GPSDO), and quartz RTC crystals drift by $20\text{–}50\text{ ppm}$ under sub-freezing alpine thermal cycling. Rather than transmitting an absolute wall-clock timestamp from a drifting sensor, `0xA1` encodes **`relativeAgeSeconds`** ($t_{\text{TX}} - t_{\text{sample}}$). When the pedestrian data mule receives the frame at GPS-locked UTC timestamp $T_{\text{RX}}$, the exact sample timestamp is reconstructed as:
  $$T_{\text{sample, UTC}} = T_{\text{RX, GPS}} - \Delta t_{\text{relativeAge}}$$

---

## 4. 2D Distributed Barometric Phased-Array & GPS-Denied Canyon SAR

Implemented in [`src/mesh-core/baroPhasedArray.ts`](src/mesh-core/baroPhasedArray.ts):

### A. Hypsometric Sea-Level Reduction ($P_0$) & Planar Gradient ($\nabla P$)
Raw station pressures $P_{\text{station}}$ across nodes at differing canyon and ridge elevations $h$ (meters ASL) and ambient temperatures $T_C$ ($^\circ\text{C}$) are first reduced to mean sea-level pressure $P_0$:

$$P_0 = P_{\text{station}} \cdot \left(1 - \frac{0.0065 \cdot h}{T_C + 0.0065 \cdot h + 273.15}\right)^{-5.257}$$

Across $N \ge 3$ mesh nodes projected onto a local tangent plane $(x_i, y_i)$ in kilometers, we solve the linear pressure field $P_0(x, y) = a x + b y + c$ via Ordinary Least Squares (OLS) to extract the horizontal pressure gradient vector:

$$\nabla P = \left(\frac{\partial P_0}{\partial x}, \frac{\partial P_0}{\partial y}\right) \quad [\text{hPa} / 100\text{ km}]$$

### B. GPS-Denied Canyon SAR Trilateration & Barometric Contour Lock
When satellite GNSS is unavailable in a deep canyon:
1. **Vertical Contour Lock ($\pm 14\text{ ft}$):** Using the peer array's solved sea-level pressure $P_0$ and the operator's local barometer $P_{\text{local}}$, the hypsometric inversion locks the operator's exact elevation contour:
   $$h_{\text{ASL}} = \frac{T_K}{0.0065} \cdot \left[ \left(\frac{P_0}{P_{\text{local}}}\right)^{\frac{1}{5.257}} - 1 \right]$$
2. **Horizontal 915 MHz RSSI/SNR Trilateration:** A 12-iteration damped Gauss-Newton solver minimizes weighted range residuals across $M$ peer anchor nodes using log-distance path-loss inversion ($n = 2.75$ canyon exponent) weighted by SNR.

---

## 5. Supported Hardware & Field Deployment

**MeshMule-Core** is hardware-agnostic and pairs out of the box over **Web Bluetooth (BLE GATT)**, **Web Serial (USB-C UART `115200 8N1`)**, and **Wi-Fi HTTP (`/api/v1/fromradio` & `/api/v1/toradio`)**:

| Hardware Platform | MCU & LoRa Transceiver | Recommended Role | Transport Support |
| :--- | :--- | :--- | :--- |
| **Heltec WiFi LoRa 32 V3** | ESP32-S3 + SX1262 (915 MHz) | Pedestrian Mule / Bench Dev Node | BLE, USB-C Serial, Wi-Fi HTTP |
| **LILYGO T-Beam Supreme** | ESP32-S3 + SX1262 + Ublox GPS + BME280 | Mobile Barometric Array & SAR Node | BLE, USB-C Serial, Wi-Fi HTTP |
| **RAK WisBlock 4631** | nRF52840 + SX1262 + Rak1906 BME680 | 5-Year Solar Backcountry Sensor Node | BLE, USB-C Serial |
| **Seeed SenseCAP T1000-E** | nRF52840 + LR1110 + Temp/Light/Baro | Ultralight Hiker / Angler Clip Tag | BLE, USB-C Magnetic |
| **B&Q Consulting Station G2** | ESP32-S3 + High-Power PA (up to 30 dBm) | Ridge-Top Ephemeris Repeater (`0xB2`) | BLE, USB-C Serial, Wi-Fi HTTP |

> **iPhone / iOS Field Pairing Note:** Apple Safari restricts Web Bluetooth on iOS. For direct Bluetooth pairing on iPhone in the backcountry, open **MeshMule-Core** inside the free **[Bluefy – Web BLE Browser](https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055)** on iOS, or connect via the ESP32-S3 Wi-Fi Hotspot (`Wi-Fi HTTP` button).

---

## 6. Agency Collector Gateway & GIS Data Ingestion

Running the development or edge gateway server exposes the live Citizen-Science Collector API at `/__telemetry/mule-collector`:

- **`POST /__telemetry/mule-collector`** — Ingests batch `0xA1` frames from returning mobile mules, verifies the 32-bit SipHash-2-4 MAC, merges multi-mule witness hashes (`stationCallsign:sequenceNumber`), and persists to `data/mule-collector-ledger.json`.
- **`GET /__telemetry/mule-collector?format=geojson`** — Exports an **RFC 7946 `FeatureCollection`** with 3D coordinates `[lon, lat, elevationMeters]` for direct drop-in loading into **ArcGIS Pro**, **QGIS**, **USGS Water Data**, or **NIFC Wildfire Situational Awareness**.
- **`GET /__telemetry/mule-collector?format=csv`** — Exports flat scientific time-series CSV tables for R, Python (`pandas`), and MATLAB hydrological/seismic analysis.

---

## 🚀 Quickstart

```bash
git clone https://github.com/49Caliber-Labs/MeshMule-core.git
cd MeshMule-core
npm install
npm run dev
```

Open `http://localhost:3100` to launch the **MeshMule-Core 915 MHz Transceiver & Citizen-Science Workbench**.

---

## 🤝 Grants, Institutional Partnerships & Sponsorship

**MeshMule-Core** is maintained by **[49Caliber Labs](https://github.com/49Caliber-Labs)** as open-source public-interest infrastructure for off-grid environmental telemetry, conservation hydrology, and wilderness search-and-rescue.

- **Sponsorship & Research Grant Tiers:** [github.com/J-O-E-L-T (Sponsorship & Grant Matrix)](https://github.com/J-O-E-L-T#-github-sponsors--research-grants-why-back-my-work)
- **Commercial Companion Platform:** Integrated with **[BiteWindow Vector7](https://github.com/49Caliber-Labs/bitewindow-vector7)** (7-Vector Hydrologic, Solunar, & Microclimate Telemetry Engine indexing 34,651 nationwide USGS waterways).
- **License:** MIT License — see [LICENSE](LICENSE).
