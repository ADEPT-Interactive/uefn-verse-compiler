# UEFN Verse Compiler

An independent, unofficial interoperability client for checking Verse projects with Epic's locally installed language server and compiling them authoritatively through a locally running Unreal Editor for Fortnite session. It is designed for developers, terminal automation, and AI coding agents that need a clear boundary between fast semantic feedback and a real UEFN build.

This project is not affiliated with, endorsed by, or sponsored by Epic Games. Fortnite, Unreal Editor for Fortnite, UEFN, Verse, Unreal Engine, and Epic Games are trademarks or properties of their respective owners.

## What it does

- Discovers UEFN-owned loopback compiler sessions without assuming one fixed port.
- Matches a requested project or explicit UEFN process when multiple editor instances are open.
- Compiles through the real local UEFN Workflow Server.
- Performs a separate semantic `check` through the installed Epic Verse language server when generated project metadata is available.
- Defaults to LSP push diagnostics and keeps generated-metadata diagnostics separate from source results; explicit workspace/pull modes are available for interoperability experiments.
- Reports installed toolchain components and backend capabilities through `doctor` and `backends`.
- Retains protocol notifications and normalizes diagnostics when locations are provided.
- Fails closed on ambiguous sessions and rejects non-loopback endpoint overrides.

`check` means semantic analysis: parsing, symbol/type/effect analysis, and related diagnostics from the Epic language server. It does not produce the same authoritative result or proven artifacts as UEFN's Build Verse Code. `compile` means the existing UEFN Workflow Server path; only its final numeric `numErrors` field is treated as authoritative. Neither command proves gameplay, publishing, moderation, or marketplace acceptance.

## Requirements

- Windows. The runtime discovery strategy is Windows-specific.
- Node.js 22.12.0 or a later Node 22 release below 25.
- For `compile`: UEFN installed and running with the intended Verse-enabled project open.
- For `check`: the Epic Verse language-server executable and the project's generated `.vproject`/digest metadata must be available. UEFN is not launched by this command, and VS Code is not required.

VS Code is not required. Epic's Verse extension was used as an interoperability reference during development, but this client does not launch VS Code and does not require a VS Code installation at runtime.

## Quick start

From a clone of this repository:

    npm ci
    npm run build
    npm run verse-compile -- status --project "C:\Path\Project.uefnproject"
    npm run verse-compile -- compile --project "C:\Path\Project.uefnproject"
    npm run verse-compile -- compile --project "C:\Path\Project.uefnproject" --json
    npm run verse-compile -- check --project "C:\Path\Project.uefnproject" --json
    npm run verse-compile -- check --project "C:\Path\Project.uefnproject" --diagnostic-mode workspace --json
    npm run verse-compile -- doctor --project "C:\Path\Project.uefnproject"
    npm run verse-compile -- backends --json

After installing a built package, the equivalent command is:

    uefn-verse-compiler compile --project "C:\Path\Project.uefnproject" --json

Normal usage does not require a host or port. For deterministic local tests only, set UEFN_VERSE_COMPILER_ENDPOINT=127.0.0.1:31962 or use the separate UEFN_VERSE_WORKFLOW_HOST and UEFN_VERSE_WORKFLOW_PORT variables. Overrides are loopback-only.

## CLI

    uefn-verse-compiler discover [--project <path>] [--process-id <pid>] [--json]
    uefn-verse-compiler status   [--project <path>] [--process-id <pid>] [--json]
    uefn-verse-compiler compile  [--project <path>] [--process-id <pid>] [--timeout-ms <ms>] [--json] [--debug]
    uefn-verse-compiler check    --project <path> [--timeout-ms <ms>] [--lsp-path <path>] [--diagnostic-mode <push|workspace|pull|both>] [--json]
    uefn-verse-compiler doctor   [--project <path>] [--lsp-path <path>] [--include-paths] [--json]
    uefn-verse-compiler backends [--project <path>] [--lsp-path <path>] [--include-paths] [--json]

discover reports candidate sessions. status reports whether discovery found a candidate, but does not claim that compilation succeeded. compile sends the live compileProject request and uses the final numeric numErrors field as its success authority.

check reports semantic diagnostics and always marks its JSON result with `resultType: "semantic-check"`, `semantic: true`, and `authoritative: false`. The default `push` mode follows Epic's installed extension: source diagnostics are usable even when generated-file diagnostics are present, and `metadataHealth` is `unverified`. `--diagnostic-mode workspace` or `both` explicitly audits the generated workspace and can return `metadata-invalid`; `pull` is an experiment and is reported unsupported when the installed server does not advertise it. A clean semantic check is not an authoritative UEFN build. doctor inspects local installation/runtime/project state; backends reports only capabilities supported by the current evidence. Neither command launches or modifies UEFN.

Exit codes are deterministic:

| Code | Meaning |
| ---: | --- |
| 0 | Clean compilation or a successful discovery/status result |
| 1 | The live compiler completed with one or more errors |
| 2 | UEFN/compiler unavailable, project not loaded, mismatch, or no initialized session |
| 3 | Multiple UEFN/compiler sessions are ambiguous |
| 4 | Invalid CLI arguments |
| 5 | Client, protocol, timeout, or other internal compiler request failure |

For `check`, code 1 means source semantic errors, code 2 means missing/unusable project metadata or an explicit workspace audit classified generated metadata as invalid, and code 5 means a client or protocol failure. Default push-mode metadata diagnostics are retained in JSON but do not by themselves change a source-clean check to code 2. `doctor` and `backends` return code 0 after producing their report, even when a backend is unavailable.

## JSON output

Normal compile --json output has this stable shape:

    {
      "schemaVersion": 1,
      "status": "compiled",
      "success": false,
      "connected": true,
      "numErrors": 2,
      "numWarnings": 1,
      "errors": [{ "severity": "error", "message": "...", "file": "...", "line": 12, "column": 4 }],
      "warnings": [],
      "diagnostics": [],
      "session": {
        "projectPath": "C:/Path/Project.uefnproject",
        "processId": 1234,
        "host": "127.0.0.1",
        "port": 1963,
        "source": "process-listener",
        "transport": "tcp-content-length-json",
        "discoveredAt": "2026-08-18T00:00:00.000Z"
      }
    }

Raw protocol messages and notifications are intentionally omitted from normal JSON. Add --debug when protocol investigation requires the retained messages; sensitive-looking fields are redacted in that output.

Semantic check JSON uses the same schema-version field but a distinct `resultType` and includes separate `sourceDiagnostics` and `metadataDiagnostics` arrays. It must not be consumed as a `compile` result.

## Multiple UEFN instances

The client identifies UEFN processes, inspects only loopback listeners owned by candidate processes, and matches the requested project where possible. Use --project for project-specific selection or --process-id when the caller already has authoritative process identity. If more than one session remains possible, discovery returns multiple-sessions-ambiguous and the CLI exits with code 3.

When a selected UEFN process exposes no enumerated listener, the client makes only the historically justified compatibility probe at 127.0.0.1:1962. Port 1962 is not the primary architecture and is not required in normal documentation or usage.

## How discovery works

The Windows strategy follows this sequence:

1. Enumerate the relevant UEFN processes and their command-line project descriptors.
2. Read the latest active project record from the local UEFN log when available.
3. Inspect loopback TCP listeners owned by the selected process.
4. Order candidates with the historical port first, then validate by the real framed compiler protocol.
5. Re-discover after stale connection failures.

The protocol uses raw local TCP with Content-Length-framed JSON. The client does not bind a listener, scan all ports, discover arbitrary LAN hosts, launch VS Code, or accept remote compiler endpoints.

## Agent integration

The self-contained agent instructions are in skills/compile-verse/SKILL.md. They describe when to use semantic `check` for fast feedback, when live `compile` is required, how to handle unavailable or ambiguous sessions, and why semantic analysis cannot be treated as equivalent.

For Windows interoperability evidence, `npm run accept:lsp -- --project "C:\Path\Project.uefnproject" --mode gate-a` runs the non-mutating Gate A corpus while UEFN and VS Code are absent. The disposable parity runner is deliberately separate and requires an explicitly acknowledged disposable project plus an independently identified active Workflow project:

    npm run parity:verse -- --project "C:\Path\Disposable\Test.uefnproject" --process-id <PID> --confirm-disposable --json

It refuses to mutate source at the project switcher or when project identity is not confirmed, hashes the original bytes, restores them after every case and in `finally`, and fails closed if restoration verification fails.

For investigation-only persistent behavior, `npm run measure:lsp -- --project "C:\Path\Project.uefnproject" --settle-ms 1200 --timeout-ms 5000 --json` probes same-file and cross-file push updates without writing the project. The installed server did not produce the expected same-file warm publications in the observed run, so no persistent/watch mode is exposed as a supported compiler path.

## Security

See SECURITY.md. In particular, compiler connections and explicit overrides are loopback-only. Do not expose the local Workflow Server to a LAN or the Internet.

## Limitations and compatibility

This tool interoperates with a local UEFN workflow service that is not necessarily a stable public Epic API. The workflow protocol may change between UEFN releases. Discovery, protocol bounds, and compatibility tests reduce avoidable breakage, but compatibility with future UEFN releases is not guaranteed.

See docs/COMPATIBILITY.md for the observed validation baseline, docs/ARCHITECTURE.md for the maintenance model, and docs/HEADLESS-VERSE-RESEARCH.md for the evidence and remaining headless questions. The project does not redistribute Epic binaries, the Verse extension, language-server files, Fortnite assets, UEFN assets, or captured proprietary implementation code.

## Development

    npm ci
    npm run check
    npm pack --dry-run

The test suite uses mocked process/listener boundaries, local mock TCP servers, synthetic project metadata, and a synthetic stdio LSP process. It does not require UEFN, VS Code, an Epic account, or proprietary files. Real language-server acceptance remains a separate Windows test; a successful semantic check is not a substitute for the live Workflow compile.

## License and disclaimer

The ADEPT-authored code in this repository is released under the MIT License. Third-party packages remain under their own licenses. This is an independent interoperability tool and not an official Epic product.
