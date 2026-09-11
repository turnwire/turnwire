English · [中文](XDG.zh.md)

# New-install XDG directories

New installations separate external application files from the source checkout using XDG base directories. Existing installations are not migrated. Absolute XDG environment values are honored; empty or relative values use the standard home defaults.

| Purpose | New default |
| --- | --- |
| Private configuration and local client connection descriptor | `$XDG_CONFIG_HOME/turnwire` or `~/.config/turnwire` |
| Session database, host state and DSH state/attachments | `$XDG_STATE_HOME/turnwire` or `~/.local/state/turnwire` |
| Installed Node/DSH runtime dependencies | `$XDG_DATA_HOME/turnwire/runtime` or `~/.local/share/turnwire/runtime` |
| Download staging and re-downloadable tools | `$XDG_CACHE_HOME/turnwire` or `~/.cache/turnwire` |

The default DSH environment file is `config-directory/dsh.env.json`, and its state is `state-directory/dsh`. The Linux unit belongs under `$XDG_CONFIG_HOME/systemd/user` (normally `~/.config/systemd/user`). Source-controlled runtime patches, build outputs and ordinary source development dependencies remain in the checkout; XDG is not a source-tree migration.

## Compatibility and overrides

- An existing `~/.turnwire` directory remains the standalone daemon/CLI default. No automatic copy, rename or deletion occurs.
- Existing managed installations with checkout-local private configuration/state/runtime artifacts retain the old layout. Starting their existing matching service does not rewrite it.
- `TURNWIRE_HOME` retains its legacy meaning for explicitly configured standalone deployments; absent per-kind overrides, configuration/data/cache stay within that layout.
- `TURNWIRE_CONFIG_HOME`, `TURNWIRE_DATA_HOME` and `TURNWIRE_CACHE_HOME` allow explicit per-kind paths. New installers record resolved paths in the service and CLI wrapper so login-shell environment changes do not disconnect the client from its host.
- Existing `TURNWIRE_DSH_HOME`, `TURNWIRE_DSH_ENV_FILE` and `TURNWIRE_DSH_ENTRY` overrides remain available.

Do not point a new install at an existing database unless it is the intended host. Protect configuration and state backups: they contain credentials and sensitive conversation content. Back up configuration, Turnwire state and DSH state/attachments; cache is disposable only when no active process depends on the files.

Tests exercise fresh defaults, absolute/relative XDG inputs, explicit overrides and legacy detection with isolated filesystem fixtures. They do not migrate the running development installation or certify a fresh production server deployment.
