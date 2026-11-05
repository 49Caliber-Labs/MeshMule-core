# Security & Cryptographic Integrity Policy

## Frame Authentication (`SipHash-2-4`)
MeshMule-Core authenticates all 32-byte `0xA1` (Backcountry Sensor Harvest) and `0xB2` (Ridge-Mule USGS Ephemeris) frames using a 32-bit truncated **SipHash-2-4** Message Authentication Code (`Bytes 28..31`).

- For production agency deployments (NPS, USGS, USFS, CDFW, NRCS), provision unique per-basin 128-bit SipHash keys onto remote sensor nodes and agency collector gateways rather than relying on the public demonstration key.
- Report any protocol vulnerabilities via GitHub Security Advisories under `49Caliber-Labs/MeshMule-core`.
