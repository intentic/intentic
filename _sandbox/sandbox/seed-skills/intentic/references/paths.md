# Key paths

```
/work                                the workspace (your worktree is mounted here during an isolated turn)
/work/refs/                          reference shelf: read, cite by path, never edit
/work/public/                        outbox: every file in it is on the public internet
/work/AGENTS.md                      the owner's standing instructions (memory), composed into every turn
/work/.intentic/config/settings.json this sandbox's agent settings (systemPromptMode, systemPrompt, modelSetups,
                                     roleSetups, roleRouting, actionRules, skills, subagent limits, rules…)
/work/.intentic/config/              capabilities.json, roles.json (the cards) and roles/<id>/ (each
                                     one's kit: PROMPT.md, skills/), automations.json, workflows.json, areas.json,
                                     environment.custom.Dockerfile (the owner-approved part of the overlay;
                                     environment.d/ and environment.Dockerfile hold steps proposed and not yet
                                     approved), skills/ (their own), approvals/ (items waiting for the owner's
                                     yes), extension-enablement.json. TRACKED: in an isolated
                                     turn this is your branch's checkout, and a file you write here (an approval,
                                     an environment.d fragment, a skill) reaches the daemon when the turn lands,
                                     reviewed like code. The live copy is at /mnt/intentic-main/.intentic/config/
<repo>/.intentic/checks.json         what THAT repository asks to have run on its own code (checks-and-ci.md)
<repo>/.intentic/sync.json           what of THAT repository the owner's computers leave out of file sync, beside the
                                     built-in list (node_modules, build output, secrets): {"ignore": ["/runs"]}, paths
                                     from the repo root, `*` within one name, no `**`/`!`. Committed; ignored files
                                     stay where they are on both sides, they just stop syncing
/work/.intentic/records/             sessions/ (transcripts), artifacts/browser/ (screenshots),
                                     artifacts/pages/<conversation>/ (pages shown in chat), artifacts/glance/
                                     (`glance` contact sheets, diffs, frames, crops). Shared live
/work/.intentic/local/               cache/, tmp/, environment.approved.Dockerfile (the composed overlay). Shared live
/work/.intentic/local/extensions/    installed extensions: clones at their pinned commit, run live. Not source: never
                                     edit them (their source is under /work/extensions/, see `extension list`)
/work/.agents/skills/                the loaded skills every runtime reads (Claude via the .claude/skills link)
/root/.claude/skills/                the image-baked skills: the intentic skill and the task skills it routes to
/root/.claude/skills/intentic/references/  the intentic skill's longer answers, each named in its routing table
/opt/sandbox/package.json            the daemon's own version ("0.0.0": an unreleased build, e.g. from a checkout)
/history/logs/                       the daemon's logs (diagnostics.md lists each file)
/history/conversations/<id>/         each conversation's record (transcript.jsonl.zst: read with `zstd -dc`)
```

## Where things live

Never walk the filesystem from `/`, `/history` or the home directory: `/history/worktrees` holds every conversation's
checkout with its own node_modules. What you cannot place has a known home:

- a skill: through your skill tool; its files are in `/root/.claude/skills/<name>/` (built in) or the workspace's
  `.agents/skills/<name>/`
- a program: `command -v <name>`
- SDKs and models baked into the image: `/opt/<name>` (`ls /opt`); agent runtimes: `/history/engines/<name>`
- a dependency's source: the project's `node_modules/<package>` (pnpm: `node_modules/.pnpm/`),
  `~/.cargo/registry/src/*/<crate>-<version>/`, or the path `python3 -c 'import m; print(m.__file__)'` prints
- another conversation's files: the worktree `agents show <handle>` names

## What runs under a turn

- **Restarts.** The sandbox restarts now and then (an update, a crash). A restart empties `/tmp` and ends every
  terminal, background job and server, so keep what a later step or turn needs (a venv, a downloaded model, a tool you
  built) in `/work/.intentic/local/cache/<tool>/`, which survives and lands nowhere.
- **Checkpoints.** The sandbox commits your work on your branch and rebases it onto main when main moves, so
  `git status` can list fewer files than you changed: `git diff $(git merge-base HEAD main)` is your whole change.
- **Stash.** Every conversation's checkout shares one `git stash`; save a patch (`git diff > /tmp/mine.patch`) instead.
- **Builds.** Build output belongs to the checkout that built it: never run or copy a binary from another
  conversation's checkout under `/history/worktrees`, which was built from different code. Where `RUSTC_WRAPPER` is
  set, every checkout's cargo shares one compiler cache (`/history/cache/sccache`), so a first build recompiles mainly
  the workspace's own crates. A new checkout's Cargo `target/` is also seeded, in the background of its first turn, from
  one that already built (a spawned child's parent's first, else the main checkout's or another conversation's with the
  same `Cargo.lock`), leaving out every crate the checkout declares itself: never rsync or copy a `target/` in by hand.
  A `target/` your build creates first is kept as it is, so a build started in the first seconds may be cold.
- **Before and after.** `base run <command>` runs a command in a read-only checkout of where your work started (the
  fork point, `git merge-base HEAD main`; `--at main` or `--at <commit>` for another), at the folder matching yours,
  and exits with the command's code (125: no base). `base path` prints that folder. It is shared per commit, kept
  outside every conversation's checkout with its builds warm, and never touches your own: no `git archive`, no
  reverting your work to build a baseline, no copied binaries (a binary is tied to the path it was built at, and a
  base's path stays put while anyone uses it). Never edit a base. A JavaScript base has no `node_modules`: run its
  install first (`base run pnpm install --offline`). `base --help`.
- **Python** has only the standard library, PyYAML and Pillow: run a script that needs more with
  `uv run --with <package> python …`.
