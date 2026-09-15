# Architecture

The package has two deliberately separate execution paths:

    project descriptor + generated .vproject/digests
                    |
          read-only project metadata
             /                    \
            /                      \
    semantic check              authoritative compile
    Epic Verse LSP               UEFN Workflow Server
    stdio JSON-RPC               loopback TCP JSON
    diagnostics only             final numeric numErrors

The backend capability model is explicit. A backend name never implies authority. The LSP backend reports semantic analysis and diagnostics, but `authoritativeCompilation: no`; the Workflow backend reports `authoritativeCompilation: yes` and requires a UEFN process. GUI coupling for the Workflow service remains unknown.

## Discovery

On Windows, the default strategy enumerates UnrealEditorFortnite-Win64-Shipping.exe, extracts a project descriptor from its command line when present, reads the latest active project record from the UEFN log, and parses netstat listener rows. Only loopback listeners whose owning process is the selected UEFN process are candidates. No broad port scan or LAN discovery is used.

Project-specific matching takes precedence over an unqualified multi-instance selection. An explicit process ID is validated and takes precedence when supplied. If the available evidence cannot identify one process, the result is multiple-sessions-ambiguous.

## Protocol

The client sends a JSON compileProject request framed as:

    Content-Length: <UTF-8 byte length>\r\n
    \r\n
    <JSON bytes>

Notifications may arrive before the final response. The client retains them for library consumers and optional debug output. The final response must identify type: 2, command: compileProject, and a numeric numErrors. numErrors: 0 is the only clean compile result.

The semantic path starts the installed Epic `verse-lsp.exe` as a child process with stdio pipes. It sends standard LSP `initialize`/`initialized`, replies to dynamic client requests, sends the exact generated workspace folder topology, opens source files, and sends full-text `didChange` notifications. The default `push` mode collects `textDocument/publishDiagnostics`; explicit `workspace` and `both` modes additionally request `workspace/diagnostic` for investigation, while `pull` is an experimental capability probe. The installed Epic server did not advertise pull diagnostics, and the official extension did not manually request workspace diagnostics. LSP ranges are converted from zero-based to the package's one-based diagnostic shape. This path never produces an authoritative Workflow compile result.

Project metadata discovery is read-only. It identifies the `.uefnproject`, generated `.vproject`, exact generated code-workspace folders and names, source `.verse` files, project asset reflection output, and built-in Verse/UnrealEngine/Fortnite digest packages. Missing or semantically invalid generated metadata is reported separately from source diagnostics. Semantic results expose `metadataHealth`: default push/pull analysis leaves generated metadata `unverified`, while an explicit workspace audit can classify it as `clean` or `invalid`.

## Recovery and diagnostics

Protocol framing, JSON, size, timeout, and connection failures are reported as client failures. After a failed discovered session, the client invalidates that attempt, re-runs discovery, and retries once. This handles UEFN restarts and stale process/listener snapshots without hiding a compiler error. Compiler messages are normalized when file, line, column, severity, or code fields are available.

LSP shutdown sends `shutdown`, then `exit`, and closes the child stdio streams. Some Epic language-server builds report a non-zero process exit value during this normal protocol sequence; the semantic result is based on JSON-RPC diagnostics and completion, not the child exit value. A bounded quiet-period fallback prevents a server that omits an empty clean-source publication from hanging forever. Timings retain spawn, initialize, first diagnostic, workspace report, analysis settle, shutdown, and total durations.

## Boundaries

The core has no application UI, Electron, storefront, entitlement, renderer, or launcher dependency. Windows discovery is isolated behind CompilerDiscoverySystem so mocked tests can cover selection and the transport can be tested without UEFN. Toolchain discovery is similarly injectable for CI. Additional platform strategies could be added later, but the current runtime support remains Windows only.

The semantic path is intentionally not a `compile` fallback. `compile` continues to use the existing Workflow backend and its loopback-only, fail-closed session selection. A Workflow listener is not sufficient evidence that the intended project is open; project identity must be established before parity or mutation work. `check` can be useful when UEFN is unavailable, but requires generated project metadata and an installed Epic language server; it does not make a claim about a headless authoritative build. The guarded disposable parity runner refuses to write source variants unless an active project and matching Workflow session are independently observed, and restores the original source in nested and outer `finally` paths.
