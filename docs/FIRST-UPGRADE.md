English · [中文](FIRST-UPGRADE.zh.md)

# Maintenance and incompatible-state refusal

This is the final operating policy, not a live deployment log or a scheduled restart. No step below authorizes unattended changes to an active host, private state or credentials.

## Supported boundary

- Configuration, state, runtime data and cache use independent [XDG directories](XDG.md), with `TURNWIRE_CONFIG_HOME`, `TURNWIRE_STATE_HOME`, `TURNWIRE_DATA_HOME` and `TURNWIRE_CACHE_HOME` overrides. There is no old-layout discovery.
- Store accepts only the current schema (storage version 2 with persistent export fragments) or a fresh database. Old/incompatible databases are refused; there is no database migration, import or old-data restoration promise. Moving files or changing schema version markers does not make them supported.
- Remote pairing is v2-only. Old pairings cannot be upgraded in place. Use a new invitation from authenticated local host management; each invitation lasts 15 minutes and is consumed once. The RPC/event envelope remains v1; it is not a v1 pairing fallback.
- TypeScript clients use SDK `call(method, params)`; shared encryption and session transport primitives live in `packages/wire`. Remote devices never gain host-maintenance permission.

## Before any maintenance

1. Arrange an external maintenance window and stop new submissions. Account for managed sessions, queued work, all descendant agents, independent DSH clients and unrelated runtime sessions. Unknown activity or a failed query is not idle.
2. Confirm the intended installation, service, resolved directories and release artifacts without printing tokens or environment values. Do not overwrite a different installation's service or client descriptor.
3. Protect consistent backups of configuration, Turnwire state and DSH state/attachments. Stop their writers before copying, or use an appropriate SQLite online backup. Never copy an active database main file without its WAL consistency. Retain the originals; a backup is not proof of compatibility with this release.
4. A full supervisor/DSH restart interrupts service and can terminate work. Neither task continuity nor restoration of old sessions is guaranteed. Do not restart the service that runs the current agent without separate operator coordination.

## Supported current-schema daemon maintenance

Follow [controlled developer deployment](SELF-HOSTING.md) only when its prerequisites apply. `scripts/host-reload.sh --daemon --dry-run` stages a build; it neither grants maintenance permission nor proves runtime readiness. A real daemon-only deployment requires a fresh authenticated supervisor readiness record and an owned durable local maintenance lease. The staged daemon's `--check-storage` validates compatibility before acquiring maintenance and again after drain but before installation; refusal neither installs the artifact nor signals a reload. Dry-run only builds and does not read the active database. Unknown readiness or unknown managed activity must fail closed. A built daemon embeds an immutable build ID and contract digest; source-mode and older identity-free health responses are not eligible for publication. Frontend publication, including explicit `--frontend`, must match the running contract; daemon-only publication must also match the currently served frontend contract and verify the exact replacement build ID. A cross-contract update requires an externally coordinated full release, not bypassing these checks. Never fabricate readiness records or edit a lease to bypass refusal.

The lease blocks new Turnwire mutations, not independent DSH clients. A ready lease persists across daemon restart until explicitly released. `turnwire maintenance compact` removes rebuildable export cache and performs SQLite maintenance, not a migration or journal/receipt deletion. Supervisor, DSH and dependency changes require their own coordinated full maintenance window.

## When an old layout or database is refused

Stop the attempt. Preserve the original files and refusal diagnostics privately; do not retry through another path, alter schema markers, delete tables or copy the old database into the XDG state directory. There is no automatic conversion or supported in-place recovery of old data in this release.

An operator may separately choose a fresh installation in empty, explicitly selected directories. It starts with new state and requires new host configuration and v2 pairings; it does not restore old identities, sessions, receipts or approvals. Keep any previous installation isolated and stopped while investigating its own version-specific options. A code rollback alone does not prove database or wire compatibility.

## Verification and uncertain outcomes

Verify supervisor/daemon identity, fresh authenticated runtime readiness and local `/health`, then separately verify Relay registration, public HTTPS/WSS reachability and a real paired-device encrypted confirmation. One green status is not evidence for every layer. Check history, pending approvals and command receipts only for the supported current state.

For `OUTCOME_UNKNOWN`, query the original request receipt with `turnwire result <request-id>`; do not resubmit a mutation just to see whether it worked. A failed deployment may intentionally leave admission closed under its durable lease. Follow the owned-lease recovery procedure in the developer guide, inspect actual health and explicitly release only after verification. Never assume a successful build is a successful deployment or an uninterrupted service.

Document the exact tests executed and conditions not exercised. Linux documentation checks do not prove macOS compilation, physical iPhone behavior, push delivery or public-network availability. History export uses isolated worker reads of persisted fragments, with bounded admission, execution time and record size; this does not establish an equivalent global memory bound for ingestion or previews.
