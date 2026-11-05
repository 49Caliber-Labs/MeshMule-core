# Contributing to MeshMule-Core

Thank you for contributing to **MeshMule-Core**, the open-source 915 MHz Delay-Tolerant Citizen-Science Telemetry, Distributed Barometric Phased-Array, and GPS-Denied Canyon SAR stack by **49Caliber Labs**.

## Engineering Standards

1. **Zero-Stub Hardware & Wire Protocol Rule:** All changes to `src/mesh-core/` and `src/services/meshtasticRadioService.ts` must maintain bit-exact compatibility with the 32-byte `0xA1` and `0xB2` wire frames and Meshtastic Protobuf (`0x94 0xC3`) framing.
2. **Airtime Discipline:** Never introduce multi-frame fragmentation on `PORTNUM=256` (`PRIVATE_APP`). Binary sensor harvest and ridge ephemeris frames must remain strictly $\le 32\text{ bytes}$ (`<65 ms` airtime at `LongFast`).
3. **Verification:** Run `npm run lint` (`tsc --noEmit`) and `npm run build` prior to submitting a Pull Request.
