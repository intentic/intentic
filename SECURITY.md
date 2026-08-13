# Security policy

## Verifying a download

Everything this project publishes is built by GitHub Actions from a tagged commit in this repository, and each
artifact carries a signed statement saying so. The signature goes to a public transparency log, so the check
below runs on your machine, against public infrastructure, without involving us — which is the point. If it
passes, the bytes you have are the bytes this repository's source produced. If it fails, do not run them.

You need the [GitHub CLI](https://cli.github.com). Nothing else, and no account.

```sh
# The desktop installer, or any binary attached to a release
gh attestation verify Intentic-<version>-x64-setup.exe --repo intentic/intentic

# The sandbox image your machine runs
gh attestation verify oci://ghcr.io/intentic/sandbox:stable --repo intentic/intentic

# The npm packages, checked against npm's own provenance attestations
npm audit signatures
```

Each answers with the workflow, the commit and the repository that produced the artifact. What it cannot tell
you is whether that source is trustworthy — that part is the reading, and it is why the source is public.

The [OpenSSF Scorecard report](https://scorecard.dev/viewer/?uri=github.com/intentic/intentic) is the other
half: eighteen automated checks over this repository's security posture, scored and published continuously,
including whether the releases you just verified are actually being signed.

## Reporting a vulnerability

**Do not open a public issue for a security problem.** Use GitHub's private reporting instead:
[**Report a vulnerability**](https://github.com/intentic/intentic/security/advisories/new). It opens a
private thread with the maintainers and stays invisible until an advisory is published.

You should get a first response within 3 working days. If a report is confirmed, the fix ships in the next
release and the advisory is published once it is out, crediting you unless you ask otherwise.

## What is in scope

The parts where a bug is most likely to matter to someone other than the operator:

| | |
| --- | --- |
| `_sandbox/sandbox` | the daemon: the workspace API, terminals, the preview proxy, the public-files outbox |
| `_sandbox/sandbox/src/secrets` | credential storage and the redaction that keeps secrets out of transcripts |
| `_sandbox/sandbox/src/guard` | the admission floor, the in-turn command and outbound gates, and the envelope that marks content the owner did not write |
| `_sandbox/sync` · `_computers/host` | the machine agents behind the two install commands, and the tunnel they open |
| `_tools/selfhost/zrok` · `_platform/api/src/sandbox/zrok*.ts` | the self-hosted tunnel hub every sandbox is reached through, and the per-sandbox reachability grants the platform mints on it |
| `_editor/desktop-app` | the installer and auto-updater |
| `_platform/api` · `_editor/web` | the hosted platform: identity and the browser workspace |
| `_extensions/*` | anything that reaches a third-party system with the operator's credentials |

Particularly interesting: **anything that crosses the sandbox boundary the wrong way** — a path that lets a
remote visitor reach the workspace API, a preview or public-files route that serves a file outside its root, a
redaction gap that puts a credential into a transcript or a log, or an agent-facing tool that escapes its
worktree. Also **an ingestion path that reaches the agent unmarked**: content the operator did not write — a
listener or Doorbell message, a fetched page, a foreign MCP server's result — that arrives outside the
`<untrusted-content>` envelope, or a way for such content to forge or escape one. On the platform side: anything that would let it reach a user's code or credentials, which
[ARCHITECTURE.md](ARCHITECTURE.md) argues it structurally cannot — except for **hosted** sandboxes, where the
platform runs the machine on its own provider account by design; there the interesting findings are the ones
that cross between hosted tenants (each machine is its own microVM on its own private network), or that let
anyone other than the platform's own configuration reach the provider credential.

## What is out of scope

- Findings that require an attacker who already has code execution or a shell in the sandbox. The sandbox runs
  the operator's agent on the operator's hardware; that agent is trusted by construction.

  What is **not** covered by that sentence, and is in scope: the agent reads content the operator did not
  write, and a workspace with a public Doorbell or a listener reads it from strangers. Trusting the agent is
  not trusting everything it has read. The envelope, the marker neutralization and the credential-read floor
  that follows outside content into a turn are there for exactly that gap — bugs in them are in scope under
  the ingestion-path clause above. Prompt injection on its own is not a vulnerability here (no in-process
  screen of model-influenced text can be); a way past one of those mechanisms is.
- Vulnerabilities in third-party dependencies with no exploitable path through this code. Report those
  upstream; Renovate carries the bump here.
- The development certificate at `_tools/localhost-https`. It is minted per machine at install time, name-
  constrained to `localhost` and the loopback addresses, and its private half never leaves the machine that
  generated it. (Until August 2026 that CA was committed here, unconstrained and valid to 2035 — if you ever
  added it to a trust store, remove it.)

## Supported versions

Fixes land on `main` and ship in the next release. There are no maintained back-release branches — the npm
packages, the container images, and the desktop installers all move forward together at one version.
