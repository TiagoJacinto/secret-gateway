# Text round trip

## Sub-features

Mask a named credential, restore it in a returned tool argument, and append the system note. Finish: the fake upstream receives no raw fixture value; the client tool argument contains the original value. Streaming, fragment-split placeholders and history masking are covered by the `streaming` and `exemptions-and-formats` journeys.

## How to get to it (user POV)

Claude Code sends a Messages request through the gateway with `ANTHROPIC_BASE_URL` pointing at it. The check substitutes a loopback fake upstream and a plain HTTP client to observe both sides without login.

## Driving it

Run `python3 .agents/verification/scripts/check.py` from the repository root. See [the verification README](../README.md) for launch settings, evidence and cleanup.

## Gotchas

- The smoke check uses `PASSWORD=` assignments. The name rule masks them, so this journey does not prove provider-pattern detection. That is covered by `detection-fixtures`.
- The system note is asserted for presence here. Its semantics are asserted in `prompt-note`.
