# @intentic/ext-knowledge

A folder of markdown notes that is also a typed graph — the people, projects, decisions and words this work
happens among, browsable here and queryable by the agent.

## Responsibilities

- Read a workspace folder of markdown notes (`knowledge/` by default) and resolve it into a graph: what each
  note IS, what it connects to, and what connects to it.
- Answer questions about that graph — search, filter by kind or tag, neighbourhood, backlinks — from its own
  backend, so the browser never fetches the vault in order to grep it.
- Let the owner read, correct and delete a note, and see what is unfinished about the vault as a whole.
- Give the AGENT the same vault through the `kb` CLI and the `knowledge` skill, driving the same engine.

## The format, in four rules

A note is markdown with a YAML-ish header. `type:` makes the note a **thing**; a `[[link]]` inside a header
field is a **named relationship**; a `[[link]]` in the prose is an ordinary connection; `tags:` and `aliases:`
work as they do in any vault. Links resolve by title, alias, filename or path, case-insensitively.

That is the whole ontology, and it is why there is no sidecar and no schema: a markdown vault could already
express a typed graph, so this reads the one it was already expressing.

## Key files

- [src/vault/frontmatter.ts](src/vault/frontmatter.ts) — the header's flat subset and its total parser.
  Deliberately not YAML; the header says why at length.
- [src/vault/note.ts](src/vault/note.ts) — what one note is: title, kind, tags, facts, links, and which of
  those links is typed.
- [src/vault/index-vault.ts](src/vault/index-vault.ts) — the pile of files becoming a graph: link resolution,
  backlinks, and what is unfinished about the whole vault.
- [src/vault/query.ts](src/vault/query.ts) — search (an explainable tier ladder, not a scoring formula) and the
  neighbourhood around one note.
- [src/vault/vocabulary.ts](src/vault/vocabulary.ts) — the words the vault has adopted, and the drift report
  that keeps them a habit rather than a gate.
- [src/vault/read-vault.ts](src/vault/read-vault.ts) — the only file-touching module, so everything above it
  stays pure and the browser half can import its types.
- [src/cli/kb.ts](src/cli/kb.ts) — the `kb` CLI (`contributes.bin`), built to `dist/bin/kb`.
- [src/server/server.ts](src/server/server.ts) — the backend half (`activateServer`), built to `dist/server.js`.
- [src/contract.ts](src/contract.ts) — the extension's OWN wire contract, imported by both halves so their wire
  cannot drift.
- [src/KnowledgeView.vue](src/KnowledgeView.vue) — the section: search, the list, the note, the health strip.
- [src/NotePane.vue](src/NotePane.vue) — one note: read, map, source, and what it is connected to.
- [plugin/skills/knowledge/SKILL.md](plugin/skills/knowledge/SKILL.md) — when the agent reads the vault and
  when it writes to it.

## How it fits

A **section of the sandbox hub, beside Memory** — reached from the sandbox chip, not from a rail tile. Memory
is what the agent has decided to remember about its work; this is what is known about the world that work
happens in. Neither has anything to announce, so neither can badge, and a permanent unlabelled rail icon that
never lights up spends a scarce seat to say nothing.

The half that gets used constantly is the CLI, not the panel: the agent looks the vault up before answering
questions about the owner's world, and writes to it when it learns something durable. The panel is where the
owner reads what it believes and corrects it.

## Conventions & gotchas

- **The notes are files, not a database.** That is what makes them greppable, git-able, openable in Obsidian,
  and editable by the agent that wrote them without a write API in between.
- **The index is built per request and never cached.** Everything shown is derived from the folder, and the
  folder is edited out of band constantly — by the agent's file tools, by `kb`, by whatever syncs a vault in. A
  few hundred short notes parse in milliseconds; a stale panel costs the feature its credibility. If a vault
  ever outgrows a scan, the answer is a watcher, not a cache with a guessed lifetime.
- **One engine, two callers.** The CLI is *built* from this package's TypeScript rather than hand-written as
  plain ESM (documentation's `intentic-docs` is), because a second implementation of the parser would be a
  vault that quietly disagrees with itself depending on who asked.
- **The vocabulary is a habit, not a gate.** An undeclared kind works immediately and is reported as drift.
  Enforcing it would fail a capture at the exact moment the fact was in hand, which is the moment the whole
  feature exists to survive.
- **Nothing is seeded on a read.** The starter vocabulary is written only when the owner presses the button in
  the empty state, and never over a vault that already has one.
- **`contributes.bin` needs the exec bit.** The daemon puts the directory on PATH; PATH resolution skips a file
  without it. The image chmods `dist/bin` — before that was true, three shipped extension CLIs were announced
  to the agent and could not be run.
