# The intentic extension registry

A list of pointers. This repository holds no extension code, builds none, and signs none: every entry names
somebody else's repository at a commit, and installing follows that pointer from your own sandbox straight to
their git host.

Because of that, **listing costs a pull request and nothing else**: no account, no upload, no packaging step,
no build service to trust. Delisting deletes nothing; it removes a pointer.

Before enabling the workflows:

1. Set `REGISTRY_SCAN_VERSION` to one exact published `@intentic/registry-scan` version.
2. Install a registry GitHub App with repository Contents + Pull requests read/write, put its id in
   `REGISTRY_APP_ID`, and store its private key as `REGISTRY_APP_PRIVATE_KEY`. App-created proposal/attestation
   commits trigger their required checks; GitHub's built-in workflow token intentionally would not.
3. Store the intentic gate door as `INTENTIC_EXTENSION_GATE_URL`.
4. Make `extension admission / admission` a required check on the default branch and require branches to be
   up to date before merging. The check is a comparison with the current base registry, so a result computed
   against an older base is not sufficient.

The App tokens are short-lived and explicitly narrowed per job, workflow actions are pinned to commits, npm
lifecycle scripts are disabled, and the registry scanner and Trivy use exact versions. Trivy parses extension
source only in a disposable job with no registry secrets or write token. Upgrading any part is an explicit
registry decision.

## Getting listed

Two ways in, and they end in the same place: a pull request against
[`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json).

**Add the topic.** Put `intentic-extension` on your GitHub repository, with an `intentic-extension.json` at
its root. A nightly job resolves the latest commit first, checks the manifest and shipped bundle at that exact
sha, and opens the pull request for you. This is the whole submission process; there is nowhere to log in.

**Or open it yourself.** Required if your extension lives in a subdirectory or isn't on GitHub: there is
nowhere for the scan to look. Copy the shape of an existing entry.

## What an entry looks like

```json
{
    "name": "acme.incidents",
    "kind": "extension",
    "trust": "listed",
    "description": "Incident triage in the rail — open alerts, acknowledge, jump to the failing run.",
    "version": "1.0.0",
    "icon": "exclamation-triangle",
    "source": { "source": "github", "repo": "acme/incidents", "sha": "9f2c1ab…" }
}
```

`name` is `publisher.name` from your manifest, not a label you choose: that is the identity the app installs
under, so two publishers can both ship an `incidents` extension and a repository that copies somebody else's
manifest collides with their listing instead of shadowing it.

`logo` (a simple-icons slug, e.g. `"linear"`) and `icon` (a glyph from the app's own set) are how the row is
drawn in the gallery and in the app's browse list. The scanner copies whichever the manifest declares, so an
author sets it once in the file they own; an entry with neither shows the extension's initials. Both are
editable here, which is the point of them riding the curated file: a reviewer can correct a mark, or strike
one, in the same pull request that lists it.

`source` also accepts `{ "source": "url", "url": … }` and `{ "source": "git-subdir", "url": …, "path": … }`
for public HTTPS repositories on GitHub, GitLab, Codeberg or Bitbucket. Give a full 40-character `sha`:
extension code runs trusted in the owner's browser, so an install pins the exact reviewed source and a branch
name isn't one. Change one executable extension per pull request. **Ship an update** with a new sha.

Do not add `securityReview` yourself. The protected workflow runs Trivy over the exact checkout in an isolated
no-secrets job, then gives the complete repository/sha/subdirectory to an intentic agent gate as untrusted data.
Author code is never executed. A pass amends the branch with both policies, tool versions and run ids; fail,
blocked, unjudged, missing evidence, or any later source-identity change keeps the pull request unmergeable.
When a policy or scanner upgrade makes existing evidence stale, those rows disappear from discovery until they
are refreshed; touch and submit them one at a time so each review keeps one complete subject.

The file is Claude Code's plugin-marketplace format on purpose. `kind` and `trust` are intentic's own fields
and Claude Code ignores what it doesn't recognise, so one repository can list your agent plugins and your
intentic extensions together.

## What `trust` claims

| | What it means | What it does not mean |
| --- | --- | --- |
| `listed` | The exact source passed Trivy and the intentic agent audit. | That a human read the code, or that future commits are safe. |
| `verified` | Both automated checks passed and somebody here also read the source. Sorted first and badged. | An ongoing audit: every claim speaks for that source only. |
| `blocked` | Known malicious or known broken, with the reason in `trustReason`. |: |

A blocked entry **stays in this file**. Deleting the row would hide it from people browsing and tell the
people who already installed it nothing, which is backwards: they are the ones at risk.

The honest summary: installing an extension is trusting its author, the same way installing an editor plugin
is. A browser bundle shares the app's page, browser storage and network access; its manifest gates cooperative
daemon calls, not arbitrary browser behavior. The deterministic scan, exact-source agent audit and optional
human review reduce that risk, but they are review controls rather than runtime isolation.

## The generated file

[`.claude-plugin/registry.generated.json`](.claude-plugin/registry.generated.json) is written by the nightly
job and holds nothing but facts read back off GitHub: stars, and the last push date. **Don't hand-edit it.**
It is separate from the curated file so that a nightly refresh never conflicts with an open pull request, and
so a review diff shows the decision being made rather than a churn of star counts.

It deliberately does not carry your latest upstream commit. The approved sha is the one that runs, and a file
advertising "there's a newer commit over there" would invite a click that skips the review this all rests on.

## Running your own

Nothing here is special. Add `.claude-plugin/marketplace.json` to any repository and it is a registry: point
a sandbox's **Capabilities → Add → Extension → From a registry** field at it, with a token if it's private,
and you have an internal catalogue that never touches this one. The official registry is a default, not a
gate.
