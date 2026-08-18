# Architecture

The client has five small layers:

    UEFN process inspection
            |
    loopback listener discovery and project/session selection
            |
    raw TCP Content-Length JSON transport
            |
    compileProject request and retained notifications
            |
    authoritative numErrors result and normalized diagnostics

## Discovery

On Windows, the default strategy enumerates UnrealEditorFortnite-Win64-Shipping.exe, extracts a project descriptor from its command line when present, reads the latest active project record from the UEFN log, and parses netstat listener rows. Only loopback listeners whose owning process is the selected UEFN process are candidates. No broad port scan or LAN discovery is used.

Project-specific matching takes precedence over an unqualified multi-instance selection. An explicit process ID is validated and takes precedence when supplied. If the available evidence cannot identify one process, the result is multiple-sessions-ambiguous.

## Protocol

The client sends a JSON compileProject request framed as:

    Content-Length: <UTF-8 byte length>\r\n
    \r\n
    <JSON bytes>

Notifications may arrive before the final response. The client retains them for library consumers and optional debug output. The final response must identify type: 2, command: compileProject, and a numeric numErrors. numErrors: 0 is the only clean compile result.

## Recovery and diagnostics

Protocol framing, JSON, size, timeout, and connection failures are reported as client failures. After a failed discovered session, the client invalidates that attempt, re-runs discovery, and retries once. This handles UEFN restarts and stale process/listener snapshots without hiding a compiler error. Compiler messages are normalized when file, line, column, severity, or code fields are available.

## Boundaries

The core has no application UI, Electron, storefront, entitlement, renderer, or launcher dependency. Windows discovery is isolated behind CompilerDiscoverySystem so mocked tests can cover selection and the transport can be tested without UEFN. Additional platform strategies could be added later, but the current runtime support remains Windows only.
