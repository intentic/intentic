# Let a named person release a credential

As someone whose agent holds credentials of very different weight — a staging password nobody worries about, the production database, the company's own X account — I want to pick out the few that matter and say who has to say yes before the agent uses one, so that the riskiest things in the sandbox are spent on somebody's decision rather than on a model's.

Masking already answers "can the agent see this value": it cannot, it reads a reference. That was never the whole question. A reference the agent can write is a credential the agent can *spend*, at whatever moment its own reasoning arrives at, and for a handful of credentials one wrong spend is the incident. So any stored secret or connected account can be put behind an exact list of people, chosen from the ones I have given access to. I am not on that list unless I put myself on it: "only Bob may release the production password" is the sentence people actually mean, and a seniority floor cannot say it.

After that, nothing about the credential works until one of those people clicks Release on a card in the live conversation: no reference resolves, no password is typed into a page, no one-time code is minted, and a gated account is not even loaded into the turn. By default each use asks again, so one click releases exactly one use; per credential I can say "for the rest of that conversation" instead. A signed-in browser, an identity's browser and a running MCP server can only be conversation-wide — they are loaded for a whole turn, so there is no single use to release — and the sandbox says so rather than offering a choice it would override.

A click from anybody the card does not name is refused and the card stays up for somebody who can, including a "skip": otherwise anyone with access could quietly cancel someone else's turn. When there is nobody to ask at all — an unattended turn, a conversation nobody is watching — the agent is refused rather than left hanging, and told who could have released it so it can carry on and say what it left undone. The secrets view shows which entries are gated and by whom, and each release is recorded on the credential's row with the name of the person who gave it.

## Acceptance criteria

- [ ] Any stored secret, and any connected account, can be put behind one or more named people, chosen from the access roster (the owner included, only if named)
- [ ] Only the owner can set or remove a gate; everybody else sees who has to approve, and is told it is the owner's to change
- [ ] A gated secret used in a command, a script or a browser field parks the turn on a card naming the approvers, and the value goes nowhere until one of them releases it
- [ ] A gated connected account is not loaded into the turn at all, and the agent is told it needs approval and how to ask, so it does not report the account as disconnected
- [ ] `secrets gates` lists what is gated and by whom; `secrets request <id> --why "…"` asks for an account or connector for the rest of the conversation
- [ ] A release covers exactly one use by default; a credential set to conversation scope is asked for once and covers the rest of that conversation
- [ ] A browser account, an identity or an MCP server can only be released for a whole conversation, and the editor says why rather than offering the choice
- [ ] A click from somebody the card does not name is refused, yes or no, and leaves the card waiting for somebody who can
- [ ] An unattended turn, a turn with no live conversation, and a reply with no verified identity are all refused, with a sentence naming who could have released it and telling the agent not to retry
- [ ] The secrets view shows which entries need approval and from whom, and a released use records who released it
- [ ] Nothing in any of this ever shows a credential's value
