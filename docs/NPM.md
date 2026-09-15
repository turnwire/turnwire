English · [中文](NPM.zh.md)

# npm distribution and releases

The public package and executable are both **turnwire** ([npm](https://www.npmjs.com/package/turnwire)). Use `@next` explicitly for previews. Under the current policy, pushes to `main` publish unique test versions to npm `next` through GitHub Actions, without a GitHub Release. Only a published formal GitHub Release with a stable `vX.Y.Z` tag and `prerelease: false` authorizes the normal stable path to npm `latest` and Release assets. All npm publication and Release asset uploads are Actions-only; local publication and local upload fallbacks are prohibited. The policy below is not evidence that a new workflow run has been tested.

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

## Documentation freshness gates

Shared installation content lives in `docs/install-snippets.json`; the minimum Node version comes from root `package.json`. After editing source content, run `npm run docs:sync` and commit the generated bilingual README, quickstart and package-guide blocks. `npm run docs:check` is read-only and fails on stale blocks; it is part of `npm run check` and a prerequisite for packaging.

The release matrix extracts a real tarball and compares both packaged READMEs with this commit's source guides (only sibling language links are rewritten). Source README follows main; package documentation follows its specific version. Old versions must not silently acquire instructions for newer code. The PR template requires a documentation impact explanation; mechanical checks do not replace human review of behavioral completeness.

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

## Publication history (not current instructions)

`0.1.0-next.0` was published manually during the initial bootstrap. Its registry integrity matched the reviewed tarball, and isolated registry installation, CLI/doctor and packaged demo/Web smoke passed. At that historical verification, both `next` and `latest` pointed to the preview. `0.1.0-next.1` was subsequently published to npm by Actions, with Release assets uploaded manually. These are historical exceptions, not the current release policy or fallback procedures. They do not establish validation of the new main-push/stable-Release automation, stable readiness, or signed native releases.

The former local first-publication instructions are retired. All future npm publications and Release asset uploads must run in Actions using the workflow below; authorization failures must be fixed there, not bypassed locally.

## GitHub Trusted Publisher setup

In npm's package settings, configure GitHub Actions with:

- Organization/user: `turnwire`
- Repository: `turnwire`
- Workflow filename: **`npm-release.yml`**
- Environment: **`npm-release`**

Keep the existing npm Trusted Publisher binding unchanged. In GitHub configure the `npm-release` environment to allow the `main` branch (push previews and manual dispatch) and `v*` tags (published stable Release events). A Release run uses its tag ref, so a main-only environment policy blocks it. The `v*` policy is an environment admission rule, not version validation: the workflow separately enforces the stricter supported version syntax and main ancestry. Protect main and version tags, limit who may publish Releases, and carefully review workflow changes. Required reviewers may be added where the plan supports them; merely naming an environment does not configure approval protection. Use GitHub-hosted runners. The workflow uses Node 24 and npm 11.6.2 for OIDC publishing, separate from application Node requirements. No `NPM_TOKEN` secret is needed, but the npm Trusted Publisher binding above is mandatory; a workflow file alone does not establish npm authorization.

The current GitHub repository is private. npm provenance is unsupported for private source repositories even for public npm packages; the workflow explicitly disables provenance for private repositories while retaining OIDC authentication, and enables it if the repository is public. It does not change repository visibility. This repository's current plan does not support required environment reviewers: do not claim an independent approval gate is active. Limit `npm-release` to main and `v*` tags and restrict repository/Release write permissions. Merging or pushing to protected main authorizes an automated preview; publishing a formal GitHub Release is the normal stable authorization boundary. Typed main-branch dispatch is limited to a preview of current main or repair of an existing formal Release. If independent approval is required, use a plan/protection mechanism that supports it before enabling automated release.

Reference: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) and [npm provenance](https://docs.npmjs.com/generating-provenance-statements/). Check these requirements again when changing CI versions.

## Main previews and stable releases

### Main pushes → npm `next`, no GitHub Release

Every push to `main` starts **Publish npm** in `.github/workflows/npm-release.yml`. The workflow takes the version from `scripts/package-npm.mjs`, strips its prerelease suffix to obtain the stable base, and derives a unique test version as `<base>-next.<github.run_number>.<shortsha>` from the immutable source commit. For example, base `0.1.0` produces a version shaped like `0.1.0-next.123.abcdef0`. The generated version is used for packaging, testing and publication; it is not a local source-version edit. A new run gets a new run number, while rerunning the same run retains its version.

After the package and DSH gates pass, Actions publishes the exact tested tarball to npm `next`. It neither creates a GitHub Release nor uploads Release assets. Preview publication never targets `latest` and does not require a prerelease tag or GitHub pre-release.

### Published formal Release → npm `latest` and assets

1. Set the stable `packageVersion` in `scripts/package-npm.mjs`, update release notes, validate and merge to main. The stable tag must match the package version at that commit; a Release does not rewrite source versions.
2. Create a strict stable `vX.Y.Z` tag pointing to a reviewed commit on main. Create its GitHub Release and click **Publish release**, leaving **pre-release** unchecked (`prerelease: false`). Drafts, Release edits and tag pushes alone do not publish stable packages. Prerelease tags and GitHub pre-releases are not a publishing path.
3. The `release: published` event starts **Publish npm**. It validates the stable tag, main ancestry and formal Release metadata, resolves the immutable commit, and runs four-platform package tests (Linux/macOS × x64/arm64) plus real Linux/macOS DSH baseline/latest/next checks. Environment approval applies only if actually configured.
4. After all gates pass, Actions validates package name/version and publishes the exact tested Ubuntu tarball to npm `latest` through OIDC, without rebuilding it. Provenance is requested only for public source repositories.
5. After npm publication succeeds, Actions attaches the same `.tgz` and `SHA256SUMS` to that existing formal Release. Assets are not silently overwritten. This private repository's Release downloads remain access-controlled even though the npm package is public.

### Manual Actions dispatch and recovery

Run **Publish npm** using `workflow_dispatch` on `main` and type `publish-turnwire` in `confirm`. The `tag` input is **optional**:

- Leave `tag` empty to publish a unique preview of current main to npm `next`, with no GitHub Release or Release assets.
- Supply an existing stable `vX.Y.Z` tag only to repair its **already published formal Release** (`draft: false`, `prerelease: false`). The same source/version/test gates apply; the workflow publishes to `latest` and uploads assets to that existing Release. It does not create a Release. Arbitrary prerelease tags and missing, draft or pre-release Releases are rejected.

If npm succeeds but an asset upload fails, publication is not rolled back. Inspect the original run and assets, then use **Re-run failed jobs** on that same Actions run so recovery uses its original tested artifact and version. Do not start a new local rebuild, republish an immutable npm version, or upload assets locally. A new dispatch is not the recovery procedure for this partially successful run. All publication and uploads remain Actions-only, with no local npm publish or `gh release upload` fallback.

PRs cannot trigger publication. Tag input is validated before checking out its source. Only the npm publish job receives `id-token: write`; the Release upload receives the narrowly scoped repository write permission it needs. No package lifecycle scripts run during publishing, and the tested tarball is not rebuilt. Failed OIDC binding must stop publication, with no broad-token fallback. This documentation describes the configured automation; it does not claim that a new Release or an automatic npm publication has been executed.

npm versions are immutable. Fix a bad release with a new version, and if necessary deliberately restore a dist-tag to a known-good version after reviewing the impact. Do not force tags or silently overwrite user configuration. Stable publication must wait for actual Linux/macOS install/start and upgrade validation; successful CI smoke alone is insufficient.
