# Give the agent a brain, on my own subscription

As someone whose sandbox is up but cannot yet do anything, I want to sign it in to the AI account I already pay for, so that I am not asked to buy tokens through a middleman to find out whether this works.

A sandbox with no AI account is a very good box with nothing in it, so this is the step that decides whether setup succeeded. It lives on the sandbox's own Agent tab rather than in settings, because the account is stored inside my sandbox and never on the platform — that is the whole argument, and putting it anywhere else would contradict it.

Each provider is a row, and each row does one thing. A sign-in unfolds inside the row that started it, so I can see which account is being connected; the action becomes the sign-in and then a way to cancel it, rather than sitting there inviting a second attempt. Nothing connects because I looked at it — switching provider shows me a state, it does not start a handshake — and once a connection exists the row says who it signed in as, so two accounts on one provider are still tellable apart.

## Acceptance criteria

- [ ] The sandbox's Agent tab lists the AI providers the agent can run as, and says which of them the sandbox currently has an account for
- [ ] Switching between providers does not start a sign-in by itself — a connection begins only when I ask for one
- [ ] Starting a sign-in unfolds its instructions inside that provider's row, and the row's action becomes a way to cancel it
- [ ] A completed connection appears as a row naming the account it signed in as, not merely as "connected"
- [ ] A provider that supports several accounts lets a second one be added, and the two rows can be told apart
- [ ] A connection can be removed, and the provider then reads as having no account again
- [ ] With no account connected, the product says the agent cannot run yet rather than failing at the first message
- [ ] While the sandbox is unreachable, the tab says so instead of showing controls that silently do nothing
- [ ] After connecting, starting a conversation and sending a message gets a reply from that provider's model
