# Feature map

Source: [issue #1](https://github.com/TiagoJacinto/secret-gateway/issues/1). Numbers refer to user stories. Each journey runs in `scripts/journeys.py`, or in `scripts/check.py` for the smoke check. A planned or unrun check is not a passed check.

| Journey | Stories | Executable evidence | Status |
| --- | --- | --- | --- |
| [Text round trip](text-round-trip.md) | 5, 14, 16 | `check.py` smoke; journeys `streaming`, `non-streaming` | PASS |
| Launch and authentication | 1–3 | `auth_probe.py` (approved live probe); `gateway_down_connect_probe.py` (approved live runs under strace; plain alias FAIL, proxy variant PASS); `gateway_up_alias_probe.py` (approved live run through the real gateway, PASS); `fail-closed` (non-loopback HOST refused); alias in setup docs | Probe PASS. Story 2 met by the proxy variant, one run each (plain alias fails). Story 1 and 3 through the real gateway PASS, one run |
| Detection and identity | 4–13, 34–35, 38 | `detection-fixtures`, `canonical-forms`, `exemptions-and-formats`, `identity-restart`, `disk-non-disclosure`; `bench/scanner.ts` | PASS. Scanner benchmark recorded |
| Streaming and prompt instructions | 14–18 | `streaming`, `non-streaming`, `prompt-note` | PASS |
| Images | 19–24, 32, 39 | `images` | Not masked, by user decision (no local OCR). Pass-through and text masking beside images checked |
| Review | 25–31, 33–36 | `review`, `notifications` | PASS. Plain notifications with the review link (buttons not used, by user decision; story 27 not met) |
| Core and failures | 37 and implementation decisions | `adapter-independence`, `fail-closed`, `disk-non-disclosure` | PASS |

Feature files: this map and [text-round-trip.md](text-round-trip.md) are kept current. The journeys' checks are listed in [../README.md](../README.md#journeys).
