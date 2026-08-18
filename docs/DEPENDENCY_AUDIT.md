# Dependency and publication audit

The standalone compiler has no runtime npm dependencies. It uses Node.js built-ins for TCP and Windows process inspection. Its development-only dependencies are:

- typescript, used for strict compilation and declaration output;
- tsx, used to execute TypeScript tests and the source CLI during development;
- @types/node, used for Node.js type declarations.

The package lock records the transitive development dependency licenses. No dependency is bundled with proprietary Epic material, and no dependency requires a third-party notice in the published source tree beyond its own package metadata. A future npm publication should repeat the lockfile audit before release.
