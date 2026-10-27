# Key paths

```
/work                                the workspace (your worktree is mounted here during an isolated turn)
/work/refs/                          reference shelf: read, cite by path, never edit
/work/public/                        outbox: every file in it is on the public internet
/work/AGENTS.md                      the owner's standing instructions (memory), composed into every turn
/work/.intentic/config/settings.json this sandbox's agent settings (systemPromptMode, systemPrompt, modelSetups,
                                     roleSetups, personaRouting, actionRules, skills, subagent limits, rules…)
/work/.intentic/config/              capabilities.json, personas.json (the cards) and personas/<id>/ (each
                                     one's kit: PROMPT.md, skills/), automations.json, workflows.json, areas.json,
                                     environment.custom.Dockerfile (the owner-approved part of the overlay;
                                     environment.d/ and environment.Dockerfile hold steps proposed and not yet
                                     approved), skills/ (their own), approvals/ (items waiting for the owner's
                                     yes), extension-enablement.json, field-notes.toon. TRACKED: in an isolated
                                     turn this is your branch's checkout, and a file you write here (an approval,
                                     an environment.d fragment, a skill) reaches the daemon when the turn lands,
                                     reviewed like code. The live copy is at /mnt/intentic-main/.intentic/config/
<repo>/.intentic/checks.json         what THAT repository asks to have run on its own code (checks-and-ci.md)
/work/.intentic/records/             sessions/ (transcripts), artifacts/browser/ (screenshots),
                                     artifacts/pages/<conversation>/ (pages shown in chat). Shared live
/work/.intentic/local/               cache/, tmp/, environment.approved.Dockerfile (the composed overlay). Shared live
/work/.intentic/local/extensions/    installed extensions: clones at their pinned commit, run live. Not source: never
                                     edit them (their source is under /work/extensions/, see `extension list`)
/work/.agents/skills/                the loaded skills every runtime reads (Claude links them from .claude/skills/)
/root/.claude/skills/                the image-baked skills: the intentic skill and the task skills it routes to
/root/.claude/skills/intentic/references/  the intentic skill's longer answers, each named in its routing table
/opt/sandbox/package.json            the daemon's own version ("0.0.0": an unreleased build, e.g. from a checkout)
/history/logs/                       the daemon's logs (diagnostics.md lists each file)
/history/conversations/<id>/         each conversation's record (transcript.jsonl.zst: read with `zstd -dc`)
```
