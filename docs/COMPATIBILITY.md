# Compatibility

## Validation baseline

The standalone extraction is based on Windows interoperability validation performed on 2026-09-14 against an installed UEFN 42.10 build (CL 57819926) and Epic's `epicgames.verse` VS Code extension/language server version 0.0.57819926. These versions are evidence for the investigation, not a universal runtime requirement.

The client was designed around the local UEFN Workflow Server behavior observed during interoperability testing:

- loopback TCP;
- Content-Length-framed JSON;
- compileProject requests;
- final numeric numErrors authority;
- process-owned listener discovery;
- project matching and fail-closed ambiguity handling.

The semantic `check` path additionally depends on the installed Epic `verse-lsp.exe`, a readable `.uefnproject`, and UEFN-generated `.vproject`/digest metadata. It uses stdio LSP framing and reports source and generated-metadata diagnostics separately. It is semantic analysis, not an authoritative build, and its compatibility is more sensitive to the exact generated package topology than the Workflow client.

The default semantic transport is LSP push diagnostics, matching the observed Epic extension: it does not issue a manual `workspace/diagnostic` request. `--diagnostic-mode workspace` and `both` are explicit audit modes; `pull` is an experimental probe. Results expose `metadataHealth` so a generated-digest failure is not confused with a source error. On the observed CL 57819926 generated workspace, the exact multi-root topology still produced 174 metadata errors; removing a generated dependency cycle reduced that to 172, while disabling VNI did not change it. Omitting the generated `vproject` hid the errors by removing required project context and is not a valid compatibility fix.

The exact UEFN build used for the originating live validation is intentionally kept in local acceptance records rather than required by this repository. Future UEFN versions may change the workflow service or its process/listener behavior.

## Compatibility notes

- Windows is the only supported runtime platform.
- VS Code is not required at runtime.
- A historical 127.0.0.1:1962 fallback is retained only when a selected UEFN process has no enumerated loopback listener.
- The client does not scan all TCP ports or accept arbitrary network endpoints.
- Multiple active UEFN sessions require project or process identity. Ambiguous selection fails closed.
- Project matching normalizes separators, case, spaces, Unicode, apostrophes, and drive letters as path text. It does not require the project file to exist in the compiler client process.
- `check` does not require VS Code and does not launch UEFN, but the installed language server and generated metadata must be present. A clean semantic result must not be used as proof of a clean UEFN build.
- `check` defaults to source-focused push semantics with generated metadata marked `unverified`; an explicit workspace audit may return `metadata-invalid`.
- `accept:lsp` is the non-mutating Windows Gate A harness. It verifies process absence, temporary LSP lifecycle, source hashes, diagnostic corpus, protocol observations, metadata breakdown, and timings.
- `parity:verse` is the only provided on-disk mutation harness. It requires explicit disposable acknowledgement and an independently matched active UEFN project/Workflow session; otherwise it performs no write. Every variant is restored byte-for-byte in `finally`, and restoration failure aborts the run.
- `doctor` and `backends` report observed local capability. They do not claim a headless compile backend unless a future comparative investigation proves one.
