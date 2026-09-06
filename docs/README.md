# docs

Which document belongs where, so a reader looking for one thing opens one directory.

- **[architecture/](architecture)** — how the running system is put together, one subject per page, plus the
  repository-level map (`repo.json` is authored; `index.json` is generated). `ARCHITECTURE.md` at the repo root
  is the index into it.
- **[design/](design)** — a decision recorded while it was being made: what was chosen, what it was chosen
  over, and what it costs. Written once, read when somebody asks "why is it like this".
- **[audits/](audits)** — what was measured, on a date, and what it said. An audit describes the tree it was
  run against, so a stale path inside one is not a defect (the layout check exempts this directory for exactly
  that reason).
- **[ops/](ops)** — running the machinery around the code: CI runners, code signing, provider conformance, the
  CLI's output protocol.
- **[marketing/](marketing)** and **[user-stories/](user-stories)** — what the product says about itself, and
  the jobs it is supposed to do.

## What does NOT live here

**What a package IS belongs to that package's own `README.md`**, updated in the same commit as the change that
invalidated it (AGENTS.md, "Documentation"). A second description in `docs/` is a copy that starts drifting the
day it is written, and the one an agent reads is the one beside the code.

Anything about the WORKSPACE rather than this repository — a harness plan, a cross-repo audit, the platform's
own operations — lives in the workspace's `/work/docs/`, not here.
