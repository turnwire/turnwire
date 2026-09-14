English · [中文](XDG.zh.md)

# XDG directories

All installations separate external application files from the source checkout using XDG base directories. Absolute XDG environment values are honored; empty or relative values use the standard home defaults. There is no old-layout detection or migration.

| Purpose | Default | Explicit override |
| --- | --- | --- |
| Private configuration and local client connection descriptor | `$XDG_CONFIG_HOME/turnwire` or `~/.config/turnwire` | `TURNWIRE_CONFIG_HOME` |
| Session database, host state and DSH state/attachments | `$XDG_STATE_HOME/turnwire` or `~/.local/state/turnwire` | `TURNWIRE_STATE_HOME` |
| Installed Node/DSH runtime dependencies | `$XDG_DATA_HOME/turnwire/runtime` or `~/.local/share/turnwire/runtime` | `TURNWIRE_DATA_HOME` (runtime is its child) |
| Download staging and re-downloadable tools | `$XDG_CACHE_HOME/turnwire` or `~/.cache/turnwire` | `TURNWIRE_CACHE_HOME` |

The default DSH environment file is `config-directory/dsh.env.json`, and its state is `state-directory/dsh`. The Linux unit belongs under `$XDG_CONFIG_HOME/systemd/user` (normally `~/.config/systemd/user`). Source-controlled runtime patches, build outputs and ordinary source development dependencies remain in the checkout.

## Explicit configuration and incompatible installations

- Each override controls only its own directory category; a state override does not relocate configuration, data or cache. Installers record resolved paths in the service and CLI wrapper. Use the same config path for daemon and clients.
- The removed monolithic home variable and old home/checkout layouts are not consulted. Old files are not copied, renamed, deleted or automatically adopted.
- `TURNWIRE_DSH_HOME`, `TURNWIRE_DSH_ENV_FILE` and `TURNWIRE_DSH_ENTRY` are explicit DSH overrides, not old-layout discovery.
- Store accepts the current database schema or creates a fresh database; it rejects old/incompatible databases without migrating them. Do not copy an old database into a new XDG directory to bypass refusal.

Protect configuration and state backups: they contain credentials and sensitive conversation content. Back up configuration, Turnwire state and DSH state/attachments consistently, with the relevant processes stopped or a supported SQLite online backup. Cache is disposable only when no active process depends on it. A backup is not a promise that this release can restore an old database.

For maintenance and refusal handling, see [Maintenance and incompatible-state refusal](FIRST-UPGRADE.md). Directory tests use isolated filesystem fixtures; they do not move a running installation or certify production deployment.
