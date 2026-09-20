# Changelog

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
