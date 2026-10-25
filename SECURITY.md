# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| Latest release (1.x) | ✅ Security fixes |
| Older releases | ❌ Please upgrade |
| Unreleased `main` | ❌ Don't deploy it (see the README, *Updating safely*) |

Security fixes are published as a new release with a note in [CHANGELOG.md](CHANGELOG.md).

## Reporting a vulnerability

**Please don't open a public issue, discussion or pull request for a security problem.**

Report it privately with GitHub's private vulnerability reporting:

1. Open this repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the problem, the affected version, and the steps to reproduce it.

Only the maintainers can see your report. This is a volunteer project: you can expect an acknowledgement within 7 days, and we'll agree on a disclosure date with you once a fix is ready. Please don't publish details before then.

**Never include real tokens, secrets, connector URLs or personal data in a report.** Use made-up values.

## Scope

In scope: this repository's code and default configuration. Examples: bypassing the secret-path check; leaking tokens, secrets or Oura data; weaknesses in the OAuth flow (state, PKCE, cookies) or in the encrypted token storage; unsafe logging; script injection on the setup pages.

Out of scope: problems in Oura, Vercel, Anthropic (Claude) or GitHub themselves (please report those to the vendor), and attacks that require someone to already have your connector URL or access to your Vercel account.

## How this project protects its users

- **Pinned, immutable releases.** Users are told to deploy a release tag or commit SHA, never `main`. Releases are immutable: a release's tag can't be moved to different code.
- **Protected default branch.** Changes reach `main` only through pull requests with passing checks. Force pushes and branch deletion are blocked.
- **Checked on every change.** CI runs lint, tests, a dependency audit and a secret scan (gitleaks) over the full history. CodeQL scans the code and the workflows.
- **Hardened supply chain.** Every GitHub Action is pinned to a full commit SHA, with read-only permissions by default. Dependencies are pinned to exact versions with a committed lockfile, and dependency install scripts are disabled. Dependabot proposes updates after a 7-day cooldown.
