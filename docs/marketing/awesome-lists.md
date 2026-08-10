# Awesome lists — where intentic can land

Curated GitHub directories worth being listed in, what each one demands before it will take us, and the
entry to paste when it will. Researched 2026-08-07 against the live repos and their contribution rules;
star counts and last-push dates are from that day.

**The one fact that orders everything below.** `intentic/intentic` went public on **2026-08-04**, first
release `v1.0.0` on **2026-08-05**, and sits at **3 stars**. Almost every list worth being on has a floor —
14 days, 50 stars, 100 stars, "released more than 4 months ago" — and submitting under the floor gets the
issue auto-closed and, on two of these lists, the account rate-limited from submitting again. So the
sequencing matters more than the list of names: **six lists take us today**, the rest unlock on dates or
star counts we can put in a calendar.

## What we are claiming

Every list matches on a different one of these, so the pitch changes per target:

| Claim | Backed by |
| --- | --- |
| Self-hosted web app | runs on your own hardware, browser is the only client, MIT including the platform |
| Agent orchestrator | fleet of parallel agents, one container + git worktree each |
| Multi-agent-CLI host | Claude Code, Codex, OpenCode, Gemini as interchangeable engines |
| MCP client | MCP servers wired in per agent as capabilities |
| Sandbox / isolation layer | Docker sandbox per agent, editable Dockerfile the user approves |
| Desktop app | Tauri app, shipped in releases (`Intentic-<version>-x64-setup.exe`, per-OS binaries) |
| Free / open source alternative | MIT, no paid tier, runs on your own model subscriptions |

## Tier 1 — submit now (no gate we fail)

| List | Stars | Section to target | Route |
| --- | --- | --- | --- |
| [awesome-opencode/awesome-opencode](https://github.com/awesome-opencode/awesome-opencode) | 9.4k | Projects | PR (`contributing.md`) |
| [ikaijua/Awesome-AITools](https://github.com/ikaijua/Awesome-AITools) | 6.1k | AI coding / developer tools | PR |
| [jamesmurdza/awesome-ai-devtools](https://github.com/jamesmurdza/awesome-ai-devtools) | 3.9k | Agent Infrastructure → Multi-Agent Orchestration | PR + checklist |
| [AwesomeHomelab/awesome-homelab](https://github.com/AwesomeHomelab/awesome-homelab) | 2.1k | Apps → Development (or AI) | Issue form |
| [ai-for-developers/awesome-ai-coding-tools](https://github.com/ai-for-developers/awesome-ai-coding-tools) | 2.0k | Coding Agents | PR |
| [bradAGI/awesome-cli-coding-agents](https://github.com/bradAGI/awesome-cli-coding-agents) | 958 | Harnesses & orchestration → Session managers & parallel runners | PR |
| [debarshibasak/awesome-paas](https://github.com/debarshibasak/awesome-paas) | 620 | Cloud IDEs | PR |
| [Piebald-AI/awesome-gemini-cli](https://github.com/Piebald-AI/awesome-gemini-cli) | 492 | Interfaces / Agent Orchestration & CLI Tools | PR |
| [RoggeOhta/awesome-codex-cli](https://github.com/RoggeOhta/awesome-codex-cli) | 462 | GUI & Desktop Apps, or Session & Workflow Management | PR |
| [steven2358/awesome-generative-ai](https://github.com/steven2358/awesome-generative-ai) | 12.4k | `DISCOVERIES.md` now, main list later | PR |

Notes that decide whether the PR survives review:

- **awesome-opencode** is the highest-leverage one open to us today: 9.4k stars, and we are a legitimate
  "Project" because OpenCode is one of the engines a sandbox can run — not a plugin claim we have to stretch.
- **jamesmurdza** rejects "general purpose AI agents/frameworks" by PR template. Lead with *developer tool*,
  never with *agent platform*.
- **bradAGI** requires a CLI or terminal interface — `@intentic/cli` (`ic` binaries in every release) plus
  the in-sandbox terminals carry that, but the entry should say so explicitly or it reads as web-only.
  Entries are sorted by stars inside a section; ours goes at the bottom until that changes.
- **steven2358** splits its list: the main README needs ~1,000 stars, everything else goes to `DISCOVERIES.md`.
  Submitting to Discoveries now is the intended path, and it is the same PR later to be promoted.
- **awesome-homelab** submits through an issue form on the old repo path (`ccbikai/awesome-homelab`) — that
  redirect is expected, not a mistake.

## Tier 2 — gated, with the unlock date

| List | Stars | Gate | Unlocks |
| --- | --- | --- | --- |
| [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) | 51.9k | 14 days since first commit **or** 100 stars | **2026-08-18** |
| [kyrolabs/awesome-ade](https://github.com/kyrolabs/awesome-ade) | 3 | ~50 stars, demonstrated traction | at 50 stars |
| [e2b-dev/awesome-ai-agents](https://github.com/e2b-dev/awesome-ai-agents) | 29.3k | none stated; 904-item backlog | now, expect months |
| [awesome-selfhosted/awesome-selfhosted](https://github.com/awesome-selfhosted/awesome-selfhosted) | 311k | first released > 4 months ago | **2026-12-05** |
| [altstackHQ/altstack-data](https://github.com/altstackHQ/altstack-data) | 319 | evidence of real-world usage | when we have users to point at |
| [tauri-apps/awesome-tauri](https://github.com/tauri-apps/awesome-tauri) | 8.0k | published app, Applications → Developer tools | now, weak fit |
| [punkpeye/awesome-mcp-clients](https://github.com/punkpeye/awesome-mcp-clients) | 6.5k | per-client detail page in README | now, medium fit |

The three that deserve real preparation:

**awesome-claude-code (51.9k stars — the single biggest prize).** Rules are strict and enforced by a bot:
submit through the web issue form only (`gh` CLI is explicitly rejected), one resource per submission,
description written as a description and not a pitch, no emoji, one line. Best-fit section is **Alternative
Clients**; **Agent Orchestration** is the fallback. Eligible from **2026-08-18** — put it in the calendar,
because an early submission is auto-closed and repeated attempts risk an interaction ban.

**awesome-selfhosted (311k stars — the biggest self-hosting audience on GitHub).** The submission is a PR
adding one YAML file to `awesome-selfhosted-data`, not an edit to the README. Requirements: actively
maintained, working install instructions, and **first released more than 4 months ago** → earliest
**2026-12-05**. Entry, exactly as written and filed once already, ready to repost as `software/intentic.yml`:

```yaml
name: intentic
website_url: https://intentic.dev
source_code_url: https://github.com/intentic/intentic
description: Workspace for running coding agents on hardware you own. Each agent gets a persistent container sandbox and a git worktree of its own, reached from any browser, and keeps working after you close the tab.
licenses:
  - MIT
platforms:
  - Docker
  - Nodejs
tags:
  - Software Development - IDE & Tools
depends_3rdparty: true
demo_url: https://intentic.dev/demo/
```

`depends_3rdparty: true` is the settled answer, and it is deliberate: sign-in and sandbox discovery go through
the hosted identity tier at intentic.dev, even though chat, terminals, files and diffs are browser-to-your-own-
machine over your own tunnel. Claiming `false` invites a reviewer to find the hosted step and distrust the rest
of the entry. Being listed here also propagates for free to the `awesome-selfhosted.net` site and the
[Correia-jpv mirror](https://github.com/Correia-jpv/fucking-awesome-selfhosted), which re-publishes the list.

**kyrolabs/awesome-ade.** Brand new list (3 stars) but the *only* one whose taxonomy is exactly ours — it has
an "Orchestrators — Web & Self-hosted" section, and Conductor, Crystal, Omnara, Sculptor and vibe-kanban are
already in it. Its bar is roughly 50 stars and visible traction, and entries go at the bottom of the section
with a star badge:

```markdown
- [intentic](https://github.com/intentic/intentic): Self-hosted workspace where each agent gets its own container and git worktree on hardware you own, reachable from any browser or phone, with plan-and-review diffs before anything lands. ![GitHub Repo stars](https://img.shields.io/github/stars/intentic/intentic?style=social)
```

## Tier 3 — cheap, low-traffic, worth a batch afternoon

Small sandbox/infrastructure lists where we are an obvious fit and the maintainer merges quickly. Low
individual value; together they are a decent backlink and discovery surface, and several feed AI search
answers about "sandboxes for coding agents":

- [tizkovatereza/awesome-ai-sandboxes](https://github.com/tizkovatereza/awesome-ai-sandboxes) (84)
- [arjan/awesome-agent-sandboxes](https://github.com/arjan/awesome-agent-sandboxes) (34)
- [webcoyote/awesome-AI-sandbox](https://github.com/webcoyote/awesome-AI-sandbox) (20)
- [dloss/awesome-agent-sandboxes](https://github.com/dloss/awesome-agent-sandboxes) (10)
- [fhiltscher/awesome-ai-coding-sandboxes](https://github.com/fhiltscher/awesome-ai-coding-sandboxes) (8)
- [fishman/awesome-agent-sandbox](https://github.com/fishman/awesome-agent-sandbox) (6)
- [Ar9av/awesome-agent-control-plane](https://github.com/Ar9av/awesome-agent-control-plane) (4)
- [backblaze-labs/awesome-agent-infrastructure](https://github.com/backblaze-labs/awesome-agent-infrastructure) (3)
- [shenli/awesome-agent-infra](https://github.com/shenli/awesome-agent-infra) (3)

Plus broader AI-agent directories that accept almost anything but move slowly:
[Jenqyang/Awesome-AI-Agents](https://github.com/Jenqyang/Awesome-AI-Agents) (1.2k),
[jim-schwoebel/awesome_ai_agents](https://github.com/jim-schwoebel/awesome_ai_agents) (1.9k),
[flatlogic/awesome-ai-software-development-agents](https://github.com/flatlogic/awesome-ai-software-development-agents) (165),
[tdi/awesome-private-ai](https://github.com/tdi/awesome-private-ai) (182),
[milisp/awesome-codex-cli](https://github.com/milisp/awesome-codex-cli) (97 — more responsive than the larger Codex list),
[agamm/awesome-developer-first](https://github.com/agamm/awesome-developer-first) (1.8k),
[filipecalegario/awesome-vibe-coding](https://github.com/filipecalegario/awesome-vibe-coding) (5.1k, 138 open issues, last push April).

## Ruled out, and why

Recording these so nobody re-researches them:

| List | Stars | Why not |
| --- | --- | --- |
| sourcegraph/awesome-code-ai | 1.7k | **Archived.** No longer accepts anything |
| RunaCapital/awesome-oss-alternatives | 19.4k | Requires a private for-profit company behind the repo; we have no paid tier |
| Shubhamsaboo/awesome-llm-apps | 131k | Demo/tutorial apps built with LLM frameworks, not tools |
| anderspitman/awesome-tunneling | 21.6k | About tunneling software; we use Cloudflare Tunnel, we are not one |
| veggiemonk/awesome-docker | 36.6k | Docker ecosystem tooling, not apps that ship in a container |
| mahseema/awesome-ai-tools | 5.9k | 1,187 open issues, no push since Dec 2025 — effectively unmaintained |
| hotheadhacker/awesome-selfhost-docker | 4.0k | No push since June 2025 |
| punkpeye/awesome-mcp-devtools | 475 | For MCP SDKs and testing utilities, not MCP-consuming apps |
| av/awesome-llm-services | 250 | Self-hostable *inference* services |

## Submitted — state re-verified 2026-08-10 21:51 UTC

Twelve pull requests, one entry each, placed in the section and format the list itself specifies. All are
single-file and additions-only, and each body discloses that the submitter maintains intentic. The State column
is live status, not day-one status — re-poll it before touching anything, because two of these have already
moved.

| List | PR | Where it lands | State |
| --- | --- | --- | --- |
| Piebald-AI/awesome-gemini-cli | [#87](https://github.com/Piebald-AI/awesome-gemini-cli/pull/87) | Agent Orchestration & CLI Tools | **merged** |
| debarshibasak/awesome-paas | [#69](https://github.com/debarshibasak/awesome-paas/pull/69) | Cloud IDE or Developer Workspaces | **merged** |
| awesome-opencode | [#580](https://github.com/awesome-opencode/awesome-opencode/pull/580) | `data/projects/intentic.yaml` | open, CI awaiting maintainer approval |
| ikaijua/Awesome-AITools | [#782](https://github.com/ikaijua/Awesome-AITools/pull/782) | AI Coding table | open, **merge conflict** — needs a rebase; own CI green |
| punkpeye/awesome-mcp-clients | [#276](https://github.com/punkpeye/awesome-mcp-clients/pull/276) | Clients, alphabetical | open, clean |
| steven2358/awesome-generative-ai | [#1191](https://github.com/steven2358/awesome-generative-ai/pull/1191) | `DISCOVERIES.md` → Coding Assistants | open, CI awaiting approval |
| jamesmurdza/awesome-ai-devtools | [#945](https://github.com/jamesmurdza/awesome-ai-devtools/pull/945) | Agent Infrastructure → Multi-Agent Orchestration | open, clean — template check green |
| AwesomeHomelab/awesome-homelab | [#114](https://github.com/AwesomeHomelab/awesome-homelab/pull/114) | `data/development.yaml` | open, clean |
| ai-for-developers/awesome-ai-coding-tools | [#603](https://github.com/ai-for-developers/awesome-ai-coding-tools/pull/603) | Coding Agents | open, clean |
| bradAGI/awesome-cli-coding-agents | [#253](https://github.com/bradAGI/awesome-cli-coding-agents/pull/253) | Session managers, sorted by stars | open, clean |
| RoggeOhta/awesome-codex-cli | [#186](https://github.com/RoggeOhta/awesome-codex-cli/pull/186) | GUI & Desktop Apps | open, clean |
| andyrewlee/awesome-agent-orchestrators | [#148](https://github.com/andyrewlee/awesome-agent-orchestrators/pull/148) | Parallel Coding Agents — Desktop & Web, alphabetical | open, clean (added 2026-08-10) |

**The last row is the best-fitting list on this page, and it was found late.** Its taxonomy is ours exactly —
the Desktop & Web section is browser and mobile agent workspaces with diff review, Garcon and IM.codes sit two
lines from our entry — and unlike the bigger lists it actually merges: 89 merged PRs against 33 open, last push
two days before we submitted. Ranked by fit times liveness it beats every Tier 1 entry above, which is the
argument for weighting *whether a list merges* as heavily as its star count when hunting for the next one.

## The 2026-08-10 incident, and the four rules that come out of it

A second round of work on 2026-08-10 re-pushed the jamesmurdza branch and opened a duplicate PR
([#958](https://github.com/jamesmurdza/awesome-ai-devtools/pull/958)) whose body was free prose instead of the
repo's template. That repo runs a bot (`PR Template Check`, on `pull_request_target: [opened, edited]`) that
**auto-closes and labels `invalid-template`** any PR whose body is missing `## Description`, `## Checklist`, all
four checklist lines verbatim, or a single `- [x]`. #958 was closed 16 seconds after it opened, and because the
duplicate shared a head commit with #945, its red check landed on #945 too. Fixed by editing #945's body back
to the template — the `edited` trigger reran the bot, it passed, and the newer success supersedes the failure on
that commit. #945 is `mergeable_state: clean` and unlabelled again.

1. **Never force-push or delete a branch that has an open submission on it.** It closes the PR and loses its
   place in a queue that is hundreds of PRs deep. Amend the entry with an ordinary commit, or leave it alone.
2. **Never open a second PR from a branch that already has one.** Edit the existing PR instead — the API
   accepts a title and body change and, on these bots, that is what re-triggers the check.
3. **Paste the target repo's PR template verbatim, every time.** Two lists enforce it with a bot. Before
   submitting, run the repo's own check script against the intended body locally; the failure mode is a closed
   PR, not a retryable red build.
4. **When a gate is missed, withdraw rather than argue.** `awesome-selfhosted-data`
   [#2883](https://github.com/awesome-selfhosted/awesome-selfhosted-data/pull/2883) was opened the same day
   against the 4-month release rule and self-withdrawn with an apology the same minute — the right move, and it
   keeps the December resubmission welcome.

## Two facts to keep straight in all copy

The submissions forced both. intentic's **native** providers are Claude Code, Codex, Grok, Kimi Code and
Google (Antigravity); **OpenCode, Gemini CLI and any other ACP agent** arrive as installable capabilities
through the ACP bridge. And the Codex path really is the Codex CLI
(`codex app-server` for native turns, with `codex exec` available for delegation), which is what makes the
Codex list a legitimate target rather than a stretch.

## Not submitted, and what each is waiting on

- **tauri-apps/awesome-tauri** — the desktop app is a real Tauri v2 app, but the list's contributing guide
  requires **signed commits**, which needs a GPG key on the submitting account (their PR template calls it
  optional; the guide does not). Also a judgement risk: the app is deliberately a thin shell around the
  hosted SPA, and the Apps criteria say "original and not too simple". Decide, then it is a five-minute PR.
- **e2b-dev/awesome-ai-agents** — submissions go through a Google Form, not a PR.
- **awesome-claude-code** — opens 2026-08-18, web issue form only.
- **kyrolabs/awesome-ade** — ~50 stars.
- **awesome-selfhosted** — 2026-12-05, YAML above. Filed early on 2026-08-10 and withdrawn the same minute
  ([#2883](https://github.com/awesome-selfhosted/awesome-selfhosted-data/pull/2883)), so the file is written and
  the December repost is a two-minute job.
- **altstackHQ/altstack-data** — wants evidence of real-world usage.
- **The Tier 3 sandbox micro-lists** — read on inspection as lists of *sandboxing libraries and cloud sandbox
  providers* (E2B, Daytona, microVM runtimes), not workspaces that use one. Submitting there would be a
  category error, so they were dropped rather than filed.

## Remaining order

1. **Now** — rebase `ikaijua/Awesome-AITools` [#782](https://github.com/ikaijua/Awesome-AITools/pull/782); the
   AI Coding table moved under it and it currently cannot merge. Rebase with an ordinary commit, never a
   branch delete (rule 1). The row itself is correct — right table, neighbour format, stars badge, `Free` —
   and the list's own checks (`link-check`, `auto-response`) are green, so the conflict is the only blocker.
   Two things worth fixing in the same pass: the PR body is prose where that list asks for the seven-field
   [recommendation template](https://github.com/ikaijua/Awesome-AITools/issues/233) (Tool Name & URL, Core
   Features, Key Differentiators, Target Users, Getting Started, Pricing, Other), and the row's engine list
   reads "Claude Code, Codex, OpenCode and Gemini CLI" without the native-versus-ACP distinction below.
2. **2026-08-18** — awesome-claude-code, through the issue form, exactly to its style rules. This is the one
   worth writing the description for twice.
3. **At 1k stars** — promote the steven2358 entry from Discoveries to the main list.
4. **At 50 stars** — kyrolabs/awesome-ade.
5. **2026-12-05** — awesome-selfhosted, with the YAML above.

The directories, launch platforms and community posts that are not GitHub lists live in
[directories.md](directories.md).

The canonical one-line description for standard awesome format, reused everywhere so the wording compounds:

```markdown
- [intentic](https://github.com/intentic/intentic) - Self-hosted workspace for a fleet of coding agents (Claude Code, Codex, OpenCode, Gemini), each in its own container and git worktree on hardware you own, driven from any browser and reviewed as diffs before anything lands.
```
