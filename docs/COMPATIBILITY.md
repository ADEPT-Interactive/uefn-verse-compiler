# Compatibility

## Validation baseline

The standalone extraction is based on Phase 23 interoperability validation performed on Windows on 2026-08-18. The observed reference tooling included Epic's epicgames.verse VS Code extension version 0.0.56430492. That version is evidence for the investigation, not a runtime requirement.

The client was designed around the local UEFN Workflow Server behavior observed during interoperability testing:

- loopback TCP;
- Content-Length-framed JSON;
- compileProject requests;
- final numeric numErrors authority;
- process-owned listener discovery;
- project matching and fail-closed ambiguity handling.

The exact UEFN build used for the originating live validation is intentionally kept in local acceptance records rather than required by this repository. Future UEFN versions may change the workflow service or its process/listener behavior.

## Compatibility notes

- Windows is the only supported runtime platform.
- VS Code is not required at runtime.
- A historical 127.0.0.1:1962 fallback is retained only when a selected UEFN process has no enumerated loopback listener.
- The client does not scan all TCP ports or accept arbitrary network endpoints.
- Multiple active UEFN sessions require project or process identity. Ambiguous selection fails closed.
- Project matching normalizes separators, case, spaces, Unicode, apostrophes, and drive letters as path text. It does not require the project file to exist in the compiler client process.
