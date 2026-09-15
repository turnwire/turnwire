English · [中文](NPM.zh.md)

# npm distribution and releases

The public package and executable are both **turnwire**. [`turnwire@0.1.0-next.0`](https://www.npmjs.com/package/turnwire) is published. Its registry integrity matches the reviewed tarball; isolated registry installation, CLI/doctor and packaged demo/Web smoke passed. It remains a preview, not a stable or signed native release. At initial verification both `next` and `latest` pointed to this preview; use `@next` explicitly. Trusted Publisher binding has not yet been confirmed; the workflow alone does not establish npm authorization.

## User experience

Install the published preview:

```sh
npx turnwire@next
# Or install persistently:
npm install -g turnwire@next
turnwire
```

Linux and macOS are the target platforms. Node.js 22.13 or newer is required by the application; use a supported recent Node release. Native Windows is not claimed. The initial preview runs in the foreground, not as a silently installed system service. Do not remove its package files or npx cache while it is running.

The launcher should connect to an existing, authenticated compatible DSH instance first; otherwise it resolves npm `latest` and offers installation of that exact version. Compatibility is checked against actual interfaces, not exact equality with the test baseline. Installation and credential setup must be explicit. Existing external DSH processes remain user-owned: stopping Turnwire must not stop them. Runtime-owned model names and capabilities are not invented by the installer. Local use does not require Relay; remote use is self-host-first, with Relay/tunnel setup optional. Never paste API keys, pairing codes or npm tokens into GitHub issues or release logs.

## First-run details

- Existing DSH: explicitly supply `TURNWIRE_DSH_URL` and `TURNWIRE_DSH_TOKEN`, or an owned mode-0600 `dsh-connection.json` containing `url` and `token` in the Turnwire config directory. No process-secret scanning; failed authentication does not install a replacement.
- Otherwise the launcher checks its managed runtime location and asks before installation. `--yes` authorizes installation, not missing model credentials.
- Model credentials come from `TURNWIRE_HARNESS_DEEPSEEK_API_KEY` or a hidden interactive prompt; existing private configuration is not overwritten.
- Foreground only. `--open` opens authenticated local Web; `--no-open` suppresses opening. The fragment bootstrap only accepts same-origin loopback and clears credentials from the location after reading.
- `--port PORT` selects Web port; `TURNWIRE_DSH_PORT` selects the owned DSH port. Occupied ports are refused, never cleared by stopping another service.
- `turnwire doctor --json` is offline and does not install or create configuration.

This preview does not automatically discover arbitrary DSH installations: reuse requires explicit connection configuration or the Turnwire-managed installation path. Other installations are not silently adopted.

## Latest DSH and safe updates

Run `turnwire start --update-dsh` to explicitly check and update managed DSH; add `--yes` to authorize installation when needed. Stop your own foreground instance first: no hot replacement during active sessions. The updater resolves npm `latest` to an exact version, installs into a separate version directory, probes authenticated interfaces with an isolated HOME and a dummy key, then atomically switches a private selection file. Failed validation leaves the previous selection unchanged and old installations retained. No automatic downgrade; external DSH and custom entries are not updated.

Normal startup does not continuously poll npm or silently update. `latest` is a publisher-controlled dist-tag and may be older than `next`. Compatibility uses observed response shapes rather than invented protocol versions or unsupported capability handshakes. See [DSH compatibility](DSH-COMPATIBILITY.md) for limits and CI coverage.

## Package documentation

The package includes standalone English and Chinese installation guides, sourced from `docs/NPM-README.md` and `docs/NPM-README.zh.md`. The packager rewrites their sibling links to `README.md` / `README.zh.md`. They do not require access to the private source repository. Repository documentation updates do not change the already-published `0.1.0-next.0` tarball or its npm README; ship package-guide changes with a new version, never republish the same version.

## Build a reviewable package

From a clean checkout with dependencies installed:

```sh
npm ci
npm run check
node scripts/package-npm.mjs
mkdir -p artifacts/npm/tarballs
npm pack ./artifacts/npm/turnwire --pack-destination ./artifacts/npm/tarballs
npm pack ./artifacts/npm/turnwire --dry-run
```

`apps/launcher/main.mjs` is the launcher source. `scripts/package-npm.mjs` prepares `artifacts/npm/turnwire`. Only the resulting reviewed tarball is published, not the monorepo root. Review its file list, package identity, license notices and SHA-256. No user config, state, database, log, private key or credential belongs in it. Workspace dependencies and source-checkout paths must not be needed after installation.

`.github/workflows/check.yml` remains the full type/test/build gate. `npm-package.yml` adds Linux/macOS package-install smoke checks outside the checkout: install the tarball without lifecycle scripts, then execute `--help`, `--version`, and offline `doctor --json` with isolated directories. It also starts the installed demo daemon on an ephemeral port and verifies health, authenticated `system.snapshot` RPC, matching Web contract and static assets. The matrix targets Linux x64/arm64 and macOS arm64/x64 using GitHub-hosted runner labels. These smoke checks do **not** prove live DSH installation, model execution, phone connectivity, background services or every CPU architecture. macOS validation is performed by Actions, not claimed from Linux development testing.

## First publication (maintainer bootstrap)

1. Confirm `npm whoami`, name availability and account 2FA. Do not store a token in this repository.
2. Review the source commit, successful CI results, tarball file list and package version. The first package must be `turnwire@0.1.0-next.0` (or deliberately revise the preview version before tagging).
3. Publish the **reviewed tarball** from a trusted local terminal, using interactive npm authentication:

   ```sh
   npm publish ./artifacts/npm/tarballs/turnwire-0.1.0-next.0.tgz --access public --tag next
   ```

   This is a manual authorization step, not an instruction to publish before validation. Do not run it from the workspace root without the tarball path. Do not claim local bootstrap provenance if none was generated.
4. Verify `npm view turnwire@next name version dist.integrity` and install that registry version in a clean environment.
5. Configure Trusted Publisher on the newly created npm package.

## GitHub Trusted Publisher setup

In npm's package settings, configure GitHub Actions with:

- Organization/user: `turnwire`
- Repository: `turnwire`
- Workflow filename: **`npm-release.yml`**
- Environment: **`npm-release`**

In GitHub configure the `npm-release` environment to allow the `main` branch (manual fallback) and `v*` tags (published Release events). A Release run uses its tag ref, so a main-only environment policy blocks it. The `v*` policy is an environment admission rule, not version validation: the workflow separately enforces the stricter supported version syntax and main ancestry. Protect main and version tags, limit who may publish Releases, and carefully review workflow changes. Required reviewers may be added where the plan supports them; merely naming an environment does not configure approval protection. Use GitHub-hosted runners. The workflow uses Node 24 and npm 11.6.2 for OIDC publishing, separate from application Node requirements. No `NPM_TOKEN` secret is needed, but the npm Trusted Publisher binding above is mandatory and is not yet confirmed.

The current GitHub repository is private. npm provenance is unsupported for private source repositories even for public npm packages; the workflow explicitly disables provenance for private repositories while retaining OIDC authentication, and enables it if the repository is public. It does not change repository visibility. This repository's current plan does not support required environment reviewers: do not claim an independent approval gate is active. Limit `npm-release` to main and `v*` tags and restrict repository/Release write permissions. Publishing a GitHub Release is the normal human authorization boundary; the typed main-branch dispatch remains a manual fallback. If independent approval is required, use a plan/protection mechanism that supports it before enabling automated release.

Reference: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) and [npm provenance](https://docs.npmjs.com/generating-provenance-statements/). Check these requirements again when changing CI versions.

## Subsequent release

1. Update `packageVersion` in `scripts/package-npm.mjs` and release notes; run validation and merge to main. The version in the tag must match the package built from that commit; creating a Release does not rewrite source versions.
2. Create a version tag pointing to the reviewed main commit, for example `v0.1.0-next.1`.
3. Create a GitHub Release for that tag and click **Publish release**. Mark `vX.Y.Z-next.N` as a **pre-release**; leave `vX.Y.Z` as a regular release. The pre-release checkbox must agree with the tag. Draft creation, Release edits, and pushing a tag alone do not trigger publication.
4. The `release: published` event automatically starts **Publish npm**. It checks tag syntax, main ancestry, and Release pre-release metadata, resolves an immutable commit, then runs the four-platform package tests (Linux/macOS × x64/arm64) and real Linux/macOS DSH baseline/latest/next checks. Environment approval applies only if actually configured.
5. After every gate passes, it validates the package name/version and publishes the exact tested Ubuntu tarball to npm through OIDC, without rebuilding it. `vX.Y.Z-next.N` goes to `next`; `vX.Y.Z` goes to `latest`. Other prerelease formats are rejected. Provenance is requested only when the source repository is public.
6. Only after npm publication succeeds, it attaches that same `.tgz` and `SHA256SUMS` to the existing GitHub Release. Existing assets are not overwritten; a name conflict fails instead of silently replacing downloads. Because this repository is private, its Release downloads remain access-controlled even though the npm package is public.

**Manual fallback:** run **Publish npm** from `main`, enter the existing tag, and type `publish-turnwire`. The same source/version/test gates apply. This fallback does not create a GitHub Release or upload Release assets. If npm succeeds but asset upload fails, npm publication is not rolled back—inspect the run and existing assets before retrying; never assume the two services update transactionally.

PRs cannot trigger publication. Tag input is validated before checking out its source. Only the npm publish job receives `id-token: write`; the Release upload receives the narrowly scoped repository write permission it needs. No package lifecycle scripts run during publishing, and the tested tarball is not rebuilt. Failed OIDC binding must stop publication, with no broad-token fallback. This documentation describes the configured automation; it does not claim that a new Release or an automatic npm publication has been executed.

npm versions are immutable. Fix a bad release with a new version, and if necessary deliberately restore a dist-tag to a known-good version after reviewing the impact. Do not force tags or silently overwrite user configuration. Stable publication must wait for actual Linux/macOS install/start and upgrade validation; successful CI smoke alone is insufficient.
