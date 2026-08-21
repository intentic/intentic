# @intentic/ext-knowledge

A folder of markdown notes that is also a typed graph: the people, projects, decisions and words this work
happens among, browsable here and queryable by the agent.

## Responsibilities

- Read a workspace folder of markdown notes (`knowledge/` by default) and resolve it into a graph: what each
  note IS, what it connects to, and what connects to it.
- Answer questions about that graph (search, filter by kind or tag, neighbourhood, backlinks) from its own
  backend, so the browser never fetches the knowledge base in order to grep it.
- Let the owner read, correct and delete a note, and see what is unfinished about the knowledge base as a whole.
- Give the AGENT the same knowledge base through the `kb` CLI and the `knowledge` skill, driving the same engine.
- Connect the owner's own **Obsidian** vault (the `obsidian` capability card), and carry notes between it and
  the workspace folder in both directions: reading the vault's notes with this same parser, so a note means
  one thing whichever side it is on.

## The format, in four rules

A note is markdown with a YAML-ish header. `type:` makes the note a **thing**; a `[[link]]` inside a header
field is a **named relationship**; a `[[link]]` in the prose is an ordinary connection; `tags:` and `aliases:`
work as they do in any knowledge base. Links resolve by title, alias, filename or path, case-insensitively.

That is the whole ontology, and it is why there is no sidecar and no schema: a markdown knowledge base could already
express a typed graph, so this reads the one it was already expressing.

## Key files

- [src/notes/frontmatter.ts](src/notes/frontmatter.ts): the header's flat subset and its total parser.
  Deliberately not YAML; the header says why at length.
- [src/notes/note.ts](src/notes/note.ts), what one note is: title, kind, tags, facts, links, and which of
  those links is typed.
- [src/notes/index-notes.ts](src/notes/index-notes.ts), the pile of files becoming a graph: link resolution,
  backlinks, and what is unfinished about the whole knowledge base.
- [src/notes/query.ts](src/notes/query.ts): search (an explainable tier ladder, not a scoring formula) and the
  neighbourhood around one note.
- [src/notes/vocabulary.ts](src/notes/vocabulary.ts): the words the knowledge base has adopted, and the drift report
  that keeps them a habit rather than a gate.
- [src/notes/read-notes.ts](src/notes/read-notes.ts): the only file-touching module, so everything above it
  stays pure and the browser half can import its types.
- [src/cli/kb.ts](src/cli/kb.ts): the `kb` CLI (`contributes.bin`), built to `dist/bin/kb`.
- [src/cli/obsidian.ts](src/cli/obsidian.ts), the `obsidian` CLI beside it, built to `dist/bin/obsidian`: the
  owner's live vault, and `pull`/`push` between it and the workspace folder.
- [src/obsidian/connection.ts](src/obsidian/connection.ts): which vaults this shell is carrying, read off the
  environment the daemon injects. A half-filled card is a connection with a problem, not an absent one.
- [src/obsidian/rest.ts](src/obsidian/rest.ts): the Local REST API calls, and the two facts about that
  transport that are not incidental: the host is `host.docker.internal`, and the certificate is self-signed.
- [skills/obsidian/SKILL.md](skills/obsidian/SKILL.md), the card's cheatsheet: which knowledge base to look in
  first, and that writing to somebody's vault is off until they turn it on.
- [src/server/server.ts](src/server/server.ts): the backend half (`activateServer`), built to `dist/server.js`.
- [src/contract.ts](src/contract.ts): the extension's OWN wire contract, imported by both halves so their wire
  cannot drift.
- [src/KnowledgeView.vue](src/KnowledgeView.vue), the section: search, the list, the note, the health strip.
- [src/KnowledgePane.vue](src/KnowledgePane.vue), one note: read, map, source, and what it is connected to. The
  frame around it (the action cluster, the delete confirmation, the read-and-write surface) is the kit's
  `<NoteEditor>`, shared with Memory.
- [plugin/skills/knowledge/SKILL.md](plugin/skills/knowledge/SKILL.md): when the agent reads the knowledge base and
  when it writes to it.

## How it fits

A **section of the sandbox hub, beside Memory**: reached from the sandbox chip, not from a rail tile. Memory
is what the agent has decided to remember about its work; this is what is known about the world that work
happens in. Neither has anything to announce, so neither can badge, and a permanent unlabelled rail icon that
never lights up spends a scarce seat to say nothing.

The half that gets used constantly is the CLI, not the panel: the agent looks the knowledge base up before answering
questions about the owner's world, and writes to it when it learns something durable. The panel is where the
owner reads what it believes and corrects it.

## Conventions & gotchas

- **The notes are files, not a database.** That is what makes them greppable, git-able, openable in Obsidian,
  and editable by the agent that wrote them without a write API in between.
- **The index is built per request and never cached.** Everything shown is derived from the folder, and the
  folder is edited out of band constantly: by the agent's file tools, by `kb`, by whatever syncs a knowledge base in. A
  few hundred short notes parse in milliseconds; a stale panel costs the feature its credibility. If a knowledge base
  ever outgrows a scan, the answer is a watcher, not a cache with a guessed lifetime.
- **One engine, two callers.** The CLI is *built* from this package's TypeScript rather than hand-written as
  plain ESM (documentation's `intentic-docs` is), because a second implementation of the parser would be a
  knowledge base that quietly disagrees with itself depending on who asked.
- **The vocabulary is a habit, not a gate.** An undeclared kind works immediately and is reported as drift.
  Enforcing it would fail a capture at the exact moment the fact was in hand, which is the moment the whole
  feature exists to survive.
- **Nothing is seeded on a read.** The starter vocabulary is written only when the owner presses the button in
  the empty state, and never over a knowledge base that already has one.
- **`contributes.bin` needs the exec bit.** The daemon puts the directory on PATH; PATH resolution skips a file
  without it. The image chmods `dist/bin`: before that was true, three shipped extension CLIs were announced
  to the agent and could not be run.
- **The vault is a copy, never a sync.** `obsidian pull` and `obsidian push` move bytes once, in the direction
  asked for. Nothing watches and nothing merges, because a two-way merge of somebody's personal notes has no
  safe default and the failure mode is silent loss of a paragraph they wrote. The workspace folder stays the
  knowledge base that is always there; the vault only answers while Obsidian is open on the owner's machine.
- **The card's skill lives in `skills/`, not `plugin/`.** Everything under `plugin/` is loaded every turn; a
  capability's `skill` is read from the checkout when the card is connected and written per instance. A vault
  cheatsheet under `plugin/` would be context spent, every turn, on a tool most sandboxes have not connected.
- **`envSuffix` comes from `@intentic/sandbox-contract/capability-env`, the leaf module.** The package barrel is
  the whole wire contract; importing it for that one naming rule pulled every oRPC route and zod into the CLI
  bundle: 376 kB against 34 kB. Deep-import the leaf, as `./tunnel-ids` and `./session-names` exist to allow.
