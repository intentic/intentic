# Let the agent use a secret it cannot see

As someone whose agent configures real systems — a Komodo stack that needs an API key in its environment, a dashboard that wants a password typed into a form — I want the agent to place my stored secrets where they belong without the values ever appearing in our conversation, so that handing it a deploy job doesn't mean handing it the keys.

Everywhere a stored value would show up in what the agent reads, it sees a stable token like `{{secret:CLOUDFLARE_API_TOKEN}}` instead — so it always knows *which* secret it is looking at, and can copy a config without destroying the value under the mask. The same token is how it spends one: written into a shell command, the real value is substituted only at the moment the command runs; on a web page, the agent focuses the field and asks for the secret to be typed. The conversation, the permission cards and the transcript only ever carry the token.

Because using a secret is an act and not a mention, each use is recorded: the secrets view shows, per entry, when the agent last actually spent it and where it went — the head of the command it rode, or the site it was typed into.

## Acceptance criteria

- [ ] A stored secret appearing in anything the agent reads is shown to it as a named reference, not the value and not an anonymous blank
- [ ] Writing that reference inside a shell command substitutes the real value at execution; the conversation keeps the reference
- [ ] A reference naming no stored secret fails the command with the names that do exist, rather than sending the token as literal text
- [ ] A user-kept secret can be typed into the focused field of a live agent browser page on request, by name, without being shown
- [ ] Each use — resolved into a command or typed into a page — appears on the secret's row in the secrets view as "last used", with where it went
- [ ] Secret values never appear in the chat, the permission cards, or the transcript
