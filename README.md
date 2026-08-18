# UEFN Verse Compiler

An independent, unofficial interoperability client for compiling Verse projects against a locally running Unreal Editor for Fortnite session. It is designed for developers, terminal automation, and AI coding agents that need authoritative live compiler diagnostics.

This project is not affiliated with, endorsed by, or sponsored by Epic Games. Fortnite, Unreal Editor for Fortnite, UEFN, Verse, Unreal Engine, and Epic Games are trademarks or properties of their respective owners.

## What it does

- Discovers UEFN-owned loopback compiler sessions without assuming one fixed port.
- Matches a requested project or explicit UEFN process when multiple editor instances are open.
- Compiles through the real local UEFN Workflow Server.
- Retains protocol notifications and normalizes diagnostics when locations are provided.
- Fails closed on ambiguous sessions and rejects non-loopback endpoint overrides.

Static syntax checking is not a substitute for the live UEFN compiler. A clean result from this tool means the live compiler returned numErrors: 0; it does not prove gameplay, publishing, moderation, or marketplace acceptance.

## Requirements

- Windows. The runtime discovery strategy is Windows-specific.
- Node.js 22.12.0 or a later Node 22 release below 25.
- UEFN installed and running with the intended Verse-enabled project open.

VS Code is not required. Epic's Verse extension was used as an interoperability reference during development, but this client does not launch VS Code and does not require a VS Code installation at runtime.

## Quick start

From a clone of this repository:

    npm ci
    npm run build
    npm run verse-compile -- status --project "C:\Path\Project.uefnproject"
    npm run verse-compile -- compile --project "C:\Path\Project.uefnproject"
    npm run verse-compile -- compile --project "C:\Path\Project.uefnproject" --json

After installing a built package, the equivalent command is:

    uefn-verse-compiler compile --project "C:\Path\Project.uefnproject" --json

Normal usage does not require a host or port. For deterministic local tests only, set UEFN_VERSE_COMPILER_ENDPOINT=127.0.0.1:31962 or use the separate UEFN_VERSE_WORKFLOW_HOST and UEFN_VERSE_WORKFLOW_PORT variables. Overrides are loopback-only.

## CLI

    uefn-verse-compiler discover [--project <path>] [--process-id <pid>] [--json]
    uefn-verse-compiler status   [--project <path>] [--process-id <pid>] [--json]
    uefn-verse-compiler compile  [--project <path>] [--process-id <pid>] [--timeout-ms <ms>] [--json] [--debug]

discover reports candidate sessions. status reports whether discovery found a candidate, but does not claim that compilation succeeded. compile sends the live compileProject request and uses the final numeric numErrors field as its success authority.

Exit codes are deterministic:

| Code | Meaning |
| ---: | --- |
| 0 | Clean compilation or a successful discovery/status result |
| 1 | The live compiler completed with one or more errors |
| 2 | UEFN/compiler unavailable, project not loaded, mismatch, or no initialized session |
| 3 | Multiple UEFN/compiler sessions are ambiguous |
| 4 | Invalid CLI arguments |
| 5 | Client, protocol, timeout, or other internal compiler request failure |

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

The self-contained agent instructions are in skills/compile-verse/SKILL.md. They describe when to use live compilation, how to handle unavailable or ambiguous sessions, how to iterate through diagnostics, and why static analysis cannot be treated as equivalent.

## Security

See SECURITY.md. In particular, compiler connections and explicit overrides are loopback-only. Do not expose the local Workflow Server to a LAN or the Internet.

## Limitations and compatibility

This tool interoperates with a local UEFN workflow service that is not necessarily a stable public Epic API. The workflow protocol may change between UEFN releases. Discovery, protocol bounds, and compatibility tests reduce avoidable breakage, but compatibility with future UEFN releases is not guaranteed.

See docs/COMPATIBILITY.md for the observed validation baseline and docs/ARCHITECTURE.md for the maintenance model. The project does not redistribute Epic binaries, the Verse extension, language-server files, Fortnite assets, UEFN assets, or captured proprietary implementation code.

## Development

    npm ci
    npm run check
    npm pack --dry-run

The test suite uses mocked process/listener boundaries and local mock TCP servers. It does not require UEFN, VS Code, an Epic account, or proprietary files. Live acceptance remains a separate Windows test with UEFN open.

## License and disclaimer

The ADEPT-authored code in this repository is released under the MIT License. Third-party packages remain under their own licenses. This is an independent interoperability tool and not an official Epic product.
