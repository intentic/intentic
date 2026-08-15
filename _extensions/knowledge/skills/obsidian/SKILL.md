---
name: obsidian
description: The owner's own Obsidian vault, live, through the Local REST API plugin — read, search, write and open notes in the app they actually keep their notes in, and carry notes between it and this workspace's knowledge base. Use whenever the user says "my vault", "my notes", "Obsidian", or asks you to look something up in, or file something into, the notes they keep themselves.
---

# ${id} — the owner's Obsidian vault

The `${id}` capability reaches an Obsidian vault **open on the owner's own machine**, over the community
[Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin. Drive it with the
`obsidian` command; it is on your PATH.

```
obsidian status                is it reachable, and may I write to it
obsidian vaults                every connected vault, by the name --vault takes
obsidian ls [folder]           the markdown files in the vault
obsidian read <file>           one note: its facts, its links, its text
obsidian find <words…>         search the vault            [--limit --context]
obsidian open <file>           bring it to the front in the owner's Obsidian window

obsidian write <file> --body "…"    write a note           [--type --tag --link rel=target --title]
obsidian append <file> --body "…"   add to the end of one
obsidian rm <file>                  delete one

obsidian pull <file…> | --all       copy vault notes into this workspace   [--into <folder>]
obsidian push <name…>               copy workspace notes into the vault    [--into <folder>]
```

Add `--json` to any of them. When more than one vault is connected, pick one with `--vault <name>`.

Credentials are in your environment already (`$OBSIDIAN_URL`, `$OBSIDIAN_API_KEY`) — the command reads them
itself, so never pass them on a command line.

## This is not the same knowledge base as `kb`

Two knowledge bases, one format:

- **`kb`** — the notes folder in this workspace, shown in the sandbox's **Knowledge** section. Always there,
  yours to write, never needs anybody's laptop to be awake.
- **`obsidian`** — the owner's personal vault, in the Obsidian window on their machine. Only reachable while
  that app is open, and it is *their* knowledge base, not the workspace's.

A note means the same thing in both: `type:` in the header makes it a thing, a `[[link]]` in a header field is
a named relationship, `tags:` and `aliases:` work as always. So `obsidian read` shows you the same facts and
edges `kb read` would, and `obsidian write` lays out a header `kb` can read back.

**Look in both before answering a question about the owner's world.** `kb find` first — it is free and always
up. If the answer is not there and the question is about something the owner would keep personally (meeting
notes, reading, a project journal), try `obsidian find`.

## Carrying notes across

`obsidian pull` copies vault notes **into** the workspace knowledge folder, keeping their paths — so
`[[links]]` between two notes that both crossed still resolve, and the Knowledge section shows them. Pull when
the owner asks you to work with their notes over several turns, or when Obsidian is about to be closed.

`obsidian push` copies workspace notes **into** the vault, byte for byte, so nothing about the owner's header
or prose is reflowed on the way in.

Neither is a sync. Nothing watches, nothing merges, and a note copied twice is overwritten by the second copy.
Say what you are about to overwrite before you overwrite it.

## Writing is off unless the owner turned it on

The card carries a write switch, and it is **off by default**. With it off, every verb that changes the vault
refuses and tells you so — that is the owner's decision, not an error to route around. Relay it and offer to
put the note in the workspace knowledge base instead (`kb new`), which is always writable.

With it on, still behave like a guest in somebody's filing system: new notes go to the card's chosen folder,
you do not reorganise, rename or delete anything you did not create, and you say what you wrote.

## When it will not connect

`obsidian status` is the first thing to run, and its message is usually the whole answer.

- **Cannot reach it** — Obsidian is closed, or the Local REST API plugin is off. Only the owner can fix that;
  ask them to open Obsidian.
- **Key refused** — the plugin's API key was regenerated. The owner re-copies it into the Obsidian card.
- **Wrong address** — from this sandbox the owner's machine is `host.docker.internal`, never `localhost`.
