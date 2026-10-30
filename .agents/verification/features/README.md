# Feature map

Source: [issue #1](https://github.com/TiagoJacinto/secret-gateway/issues/1). Numbers refer to user stories. Each journey runs in `scripts/journeys.py`, or in `scripts/check.py` for the smoke check. A planned or unrun check is not a passed check.

| Journey | Stories | Executable evidence | Status |
| --- | --- | --- | --- |
| [Text round trip](text-round-trip.md) | 5, 14, 16 | `check.py` smoke; journeys `streaming`, `non-streaming` | PASS |
| Launch and authentication | 1–3 | `auth_probe.py` (approved live probe); `gateway_down_probe.py` (approved live run); `fail-closed` (non-loopback HOST refused); alias in setup docs | Probe PASS. Gateway-down PASS as defined (no reply; request path not shown) |
| Detection and identity | 4–13, 34–35, 38 | `detection-fixtures`, `canonical-forms`, `exemptions-and-formats`, `identity-restart`, `disk-non-disclosure`; `bench/scanner.ts` | PASS. Scanner benchmark recorded |
| Streaming and prompt instructions | 14–18 | `streaming`, `non-streaming`, `prompt-note` | PASS |
| Images | 19–24, 32, 39 | `images` | Not masked, by user decision (no local OCR). Pass-through and text masking beside images checked |
| Review | 25–31, 33–36 | `review`, `notifications` | PASS. Plain notifications with the review link (buttons not used, by user decision; story 27 not met) |
| Core and failures | 37 and implementation decisions | `adapter-independence`, `fail-closed`, `disk-non-disclosure` | PASS |

Feature files: this map and [text-round-trip.md](text-round-trip.md) are kept current. The journeys' checks are listed in [../README.md](../README.md#journeys).
