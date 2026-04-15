# Changelog

## 0.1.0 - 2026-04-15

- First public version.
- Added a generic local facade proxy for OpenClaw OpenAI-compatible `Responses` providers.
- Added one-click install and uninstall scripts for macOS LaunchAgent deployments.
- Added experimental Debian / Ubuntu support through `systemd --user`.
- Added install-state snapshots so uninstall can restore Gateway environment values instead of writing fixed defaults.
- Added Chinese documentation for installation, verification, rollback, and caveats.
- Verified end-to-end cache-read recovery for `custom-beehears`.
- Verified multi-provider facade routing for `custom-beehears` and `custom-memory`.
