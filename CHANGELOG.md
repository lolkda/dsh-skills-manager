# Changelog

## 0.2.2 (2026-09-24)

第一个经 GitHub Actions 发布的版本。`0.2.1` 与 `0.2.2-rc.1` 只存在于本仓库的提交里，从未发到 npm；`0.2.2` 把它们的内容一起带上。

### Added

- GitHub Actions release pipeline: pushing a `v<version>` tag (or a manual dispatch with a dry-run option) runs the test suite, packs the tarball, and publishes it to npm. Stable versions go to `latest`, versions containing `-` go to `next`, so a prerelease can never take over `latest`.
- Authentication uses npm Trusted Publishing (OIDC): no long-lived npm token and no repository secret. The publish job holds `id-token: write`, npm (>= 11.5.1) exchanges the GitHub id_token for a package-scoped short-lived token, and the same id_token signs the provenance attestation.
- A preflight step fails fast when the OIDC prerequisites are missing (npm older than 11.5.1, or no `id-token: write`), and the dry-run mode asserts that credentials were actually available — a bare `npm publish --dry-run` exits 0 even with no credentials at all, which makes it useless as a rehearsal.
- `scripts/release-plan.mjs` derives the git tag and dist-tag from `package.json` and refuses to publish when the tag does not match the version or when the ref is not a tag. Covered by `test/release-plan.test.mjs`.
- `ci.yml` runs the same `npm run check` on branches and pull requests, on Node 24 and Node 22 (`engines` lower bound).

### Fixed

- Add the missing `@deepseek-ai/dsh-tools` dev dependency. `test/tools.test.mjs` imports it for the JSON Schema subset assertions, so without it that file failed at import and the suite could not be green on a clean checkout: 189 passing / 1 failing before, 196 passing / 0 failing after.

### Notes

- Release procedure, the one-time Trusted Publisher registration on npmjs.com, and the pitfalls found while testing this locally: [docs/release.md](https://github.com/lolkda/dsh-skills-manager/blob/master/docs/release.md). No step requires running `npm publish` locally or storing an npm token.

## 0.2.1

### Fixed

- Bind skill registry checks to the GUI's selected session instead of the first agent with the same working directory. Skills added directly to DSH's skill directories are no longer falsely reported as missing because an older session has an empty registry.
- Send the current session ID and working directory through the settings panel's catalog and registry requests.
- Clear session-specific UI state and discard delayed responses after switching sessions, including switches within the same directory.
- Reject registry responses for another session, including responses from older backends that ignore the session ID.
- Leave checks inconclusive when the requested session is unavailable or the directory has multiple candidates and no session ID was supplied. Explicitly selected empty sessions still report genuine differences.

### Tests

- Add 15 regression cases using real DSH registries, filesystem providers, temporary skill directories, and client-to-route requests.
- Targeted suite: 67 passing tests.
- Full suite on Linux / Node 24.21.0 / DSH 0.1.6-alpha.2: 179 passing, 5 pre-existing failures. These are one attachment file-to-directory overwrite failure and four Windows-specific path assertions; see the [verification report](https://github.com/lolkda/dsh-skills-manager/blob/master/docs/session-registry-fix.md#全量验证).

### Upgrade

- No skill content, invocation policy, or saved override is migrated or rewritten.
- Replacing an installed plugin requires restarting the DSH host; a browser refresh alone does not replace its loaded ESM backend.
