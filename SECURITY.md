# Security Policy

## Scope

This project is a local compiler interoperability client. It does not handle Epic credentials, publish islands, modify account settings, bypass project permissions, or patch Epic binaries.

## Security boundaries

- Compiler connections are restricted to loopback addresses.
- Explicit endpoint overrides reject LAN and Internet hosts.
- The client does not scan arbitrary ports or perform LAN discovery.
- Project paths are passed as data to fixed local inspection commands; they are not shell commands.
- Process IDs are validated as positive integers before they influence selection.
- Content-Length frames are bounded to prevent unbounded protocol memory use.
- Normal JSON output excludes raw protocol notifications and redacts sensitive-looking fields in opt-in debug output.

Do not expose the UEFN Workflow Server to a LAN or the Internet. This tool does not add authentication to that local service.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the ADEPT Interactive maintainers through the security contact published in the GitHub repository, or use GitHub's private vulnerability reporting if enabled. Do not include credentials, cookies, account identifiers, proprietary Epic files, or raw machine captures in a public issue.

## Supported boundary

The supported runtime is Windows with a locally running UEFN editor. A vulnerability report about a future UEFN protocol change is welcome, but this project cannot guarantee compatibility with undocumented behavior that Epic changes.
