# The intentic extension registry

A list of pointers. This repository holds no extension code, builds none, and signs none — every entry names
somebody else's repository at a commit, and installing follows that pointer from your own sandbox straight to
their git host.

Because of that, **listing costs a pull request and nothing else**: no account, no upload, no packaging step,
no build service to trust. Delisting deletes nothing; it removes a pointer.

## Getting listed

Two ways in, and they end in the same place — a pull request against
[`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json).

**Add the topic.** Put `intentic-extension` on your GitHub repository, with an `intentic-extension.json` at
its root. A nightly job finds it, checks the manifest parses, resolves your latest commit, and opens the pull
request for you. This is the whole submission process; there is nowhere to log in.

**Or open it yourself.** Required if your extension lives in a subdirectory or isn't on GitHub — there is
nowhere for the scan to look. Copy the shape of an existing entry.

## What an entry looks like

```json
{
    "name": "acme.incidents",
    "kind": "extension",
    "trust": "listed",
    "description": "Incident triage in the rail — open alerts, acknowledge, jump to the failing run.",
    "version": "1.0.0",
    "source": { "source": "github", "repo": "acme/incidents", "sha": "9f2c1ab…" }
}
```

`name` is `publisher.name` from your manifest, not a label you choose — that is the identity the app installs
under, so two publishers can both ship an `incidents` extension and a repository that copies somebody else's
manifest collides with their listing instead of shadowing it.

`source` also accepts `{ "source": "url", "url": … }` for any git host and
`{ "source": "git-subdir", "url": …, "path": … }` for one repo holding several extensions. Give a full
40-character `sha`: extension code runs trusted in the owner's browser, so an install pins the exact reviewed
commit and a branch name isn't one. **Ship an update** by opening another pull request with a new sha.

The file is Claude Code's plugin-marketplace format on purpose. `kind` and `trust` are intentic's own fields
and Claude Code ignores what it doesn't recognise, so one repository can list your agent plugins and your
intentic extensions together.

## What `trust` claims

| | What it means | What it does not mean |
| --- | --- | --- |
| `listed` | The pointer resolves, the manifest parses, the publisher owns the source repo. | That anybody read the code. |
| `verified` | Somebody here read the source at that commit. Sorted first, badged in the app and the gallery. | An ongoing audit — it speaks for that sha only. |
| `blocked` | Known malicious or known broken, with the reason in `trustReason`. | — |

A blocked entry **stays in this file**. Deleting the row would hide it from people browsing and tell the
people who already installed it nothing, which is backwards — they are the ones at risk.

The honest summary: installing an extension is trusting its author, the same way installing an editor plugin
is. What intentic adds is that the trust is bounded and legible — the manifest is the approval surface, you
read what an extension may touch before you say yes, and it cannot grow past that without asking you again.

## The generated file

[`.claude-plugin/registry.generated.json`](.claude-plugin/registry.generated.json) is written by the nightly
job and holds nothing but facts read back off GitHub: stars, and the last push date. **Don't hand-edit it.**
It is separate from the curated file so that a nightly refresh never conflicts with an open pull request, and
so a review diff shows the decision being made rather than a churn of star counts.

It deliberately does not carry your latest upstream commit. The approved sha is the one that runs, and a file
advertising "there's a newer commit over there" would invite a click that skips the review this all rests on.

## Running your own

Nothing here is special. Add `.claude-plugin/marketplace.json` to any repository and it is a registry — point
a sandbox's **Capabilities → Add → Extension → From a registry** field at it, with a token if it's private,
and you have an internal catalogue that never touches this one. The official registry is a default, not a
gate.
