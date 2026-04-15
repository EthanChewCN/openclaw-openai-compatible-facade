# Changelog

## 0.1.1 - 2026-04-15

- Hardened facade routing by enforcing provider-to-upstream allowlist matching.
- Added install-state snapshots and symmetric restore handling for Gateway environment changes.
- Tightened permissions for generated runtime and backup files.
- Added explicit macOS post-install verification so install no longer reports success before the facade and Gateway are reachable.
- Updated release notes and documentation to reflect the hardened behavior and current support boundaries.

## 0.1.0 - 2026-04-15

- First public version.
- Added a generic local facade proxy for OpenClaw OpenAI-compatible `Responses` providers.
- Added one-click install and uninstall scripts for macOS LaunchAgent deployments.
- Added experimental Debian / Ubuntu support through `systemd --user`.
- Added install-state snapshots so uninstall can restore Gateway environment values instead of writing fixed defaults.
- Added Chinese documentation for installation, verification, rollback, and caveats.
- Verified end-to-end cache-read recovery for `custom-beehears`.
- Verified multi-provider facade routing for `custom-beehears` and `custom-memory`.
