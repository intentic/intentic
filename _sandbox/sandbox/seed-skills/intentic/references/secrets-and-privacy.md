# Secrets, gated credentials, host guards, keyrings and the privacy shield

## Using a secret

Secrets are stored by the owner (Sandbox ▸ Secrets) and reach you only as `{{secret:name}}` references, substituted at
execution. You never see a value and never ask for one in chat. To use one, write `{{secret:name}}` in the command; an
unknown name fails and lists the names that exist. In a file you write, keep the reference, never a value.

- **One nobody has stored**: `secrets ask NAME --why "…"` puts a masked field on a card in the chat, and the answer
  comes back once it is stored (`--link` where to get one, `--hint` what it looks like, `--replace` for a stored one
  being refused, `--where` how it will be used). Never a request to paste it into chat.
- **One the task can make itself** (a session key, a webhook signing secret, a database password it sets up):
  `secrets generate NAME`, which needs nobody, never shows the value and never hardcodes one into a file.
- **A password for a PLACE whose name you do not know** is asked for by need: `secrets want --site github.com` (or
  `--program FortiClient.exe`, `--ssh user@host`, `--git https://host`, with `--user` when you know the account)
  `--why "…"`. Passwords on the owner's computers finds the entry that fits and asks the person; the command prints the
  NAME to reference, exits 3 while the answer waits in Passwords there, and 1 on a no.

## Gated secrets and accounts

A few may be **gated to a named person**: using one raises a card for them and your turn waits, and a gated connected
account is not loaded into your turn at all, so it can look unconnected. For a credential that says it needs approval,
or an account that looks unconnected, run `secrets gates` (what is gated and by whom); then
`secrets request <id> --why "…"` for an account or connector (it mounts from the next turn), or just write the secret's
reference and let the card go up for that one use. A refusal is somebody's decision: carry on without it and say plainly
what you left undone.

## Host guards

A secret may also have its **host guard** on (a connector's own credential starts with it on, set to its service's
hosts): it goes unasked only when every host the command names is on its list and the reader can follow where it goes
(a `curl`, `wget` or `git` command, piped into a reader like `jq` or `head`, or joined to more by `&&` or `;`). A
script, an interpreter, a subshell, `curl -L` or a host from a variable filled in as it runs (not one set to a plain
value earlier in the line) waits for a person's click, whatever the safety judge thinks, and an unattended turn is
refused. `secrets gates` shows the gate and the guard on one line per secret; `secrets hosts` shows and edits the guard.

A secret refused or carded for where it was going has its host guard on: `secrets hosts NAME` says where it may go, so
aim one plain `curl`/`wget`/`git` command straight at those hosts. To let it go somewhere new for good,
`secrets hosts NAME add HOST` asks the owner on a card, as does `secrets hosts NAME off`; `on` and `remove` need nobody.

## Secrets kept on the owner's computers

Some secrets live in a **keyring on one of the owner's computers** (`intentic-keyring`, beside `intentic-machine`) and
the sandbox holds only a pointer: the Secrets view lists them under "On your computers". You spend one exactly like any
other: a reference in a command, or `mcp__secrets__type_secret` aimed (`where`) at a window on a connected computer, a
phone attached to it, the sandbox's desktop, a page in one of the sandbox's browsers or the owner's own browser. Each
use is asked of that computer, which may ask the person there, so an offline or locked computer is a refusal to report,
not to work around. Typing into a window goes unasked only into a program on the secret's list (`secrets programs`
reads and narrows it; widening is the owner's). `mcp__secrets__type_secret` takes `for: {site}` or `for: {program}`
instead of a name, to do at typing time what `secrets want` does.

For a secret the task needs on the owner's machine, `secrets ask` lets the owner keep it there ("Keep it on my
computer") when a computer's keyring answers; the card defaults to "Keep it in the sandbox".

## The privacy shield

Personal data (names, PESEL, ID numbers) kept from untrusted model providers, or tokens like `⟦PERSON_3⟧` in what you
read, is the privacy shield, the owner's to switch on in Sandbox ▸ Privacy & safety ▸ Privacy shield. `privacy` says
whether it is on and which providers are trusted. While it is on, an untrusted provider reads personal data as tokens
that are turned back into the values on this machine: write a token exactly as given wherever its value belongs (a
command, a query, an edit) and it resolves before anything runs. Before working through a dataset of people, teach it:
`privacy learn <file> --column first_name+last_name --column pesel:national-id` (CSV, TSV, JSON lines, or SQLite with
`--table` or `--query`); the values go to the daemon and are never printed. Turning it off, trusting a provider or
forgetting a dataset is the owner's.
