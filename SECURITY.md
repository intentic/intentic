# Security policy

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
| `_sandbox/sync` · `_computers/host` | the machine agents behind the two install commands, and the tunnel they open |
| `_editor/desktop-app` | the installer and auto-updater |
| `_platform/api` · `_editor/web` | the hosted platform: identity, billing, and the browser workspace |
| `_extensions/*` | anything that reaches a third-party system with the operator's credentials |

Particularly interesting: **anything that crosses the sandbox boundary the wrong way** — a path that lets a
remote visitor reach the workspace API, a preview or public-files route that serves a file outside its root, a
redaction gap that puts a credential into a transcript or a log, or an agent-facing tool that escapes its
worktree. On the platform side: anything that would let it reach a user's code or credentials, which
[ARCHITECTURE.md](ARCHITECTURE.md) argues it structurally cannot.

## What is out of scope

- Findings that require an attacker who already has code execution or a shell in the sandbox. The sandbox runs
  the operator's agent on the operator's hardware; that agent is trusted by construction.
- Vulnerabilities in third-party dependencies with no exploitable path through this code. Report those
  upstream; Renovate carries the bump here.
- The self-signed `DNS:localhost` certificate committed at `_tools/localhost-https`. It exists so local dev can
  serve HTTPS (Google FedCM refuses `http://localhost`) and grants nothing off the machine that holds it.

## Supported versions

Fixes land on `main` and ship in the next release. There are no maintained back-release branches — the npm
packages, the container images, and the desktop installers all move forward together at one version.
