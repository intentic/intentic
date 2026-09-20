# Give the agent a brain, on my own subscription

As someone whose sandbox is up but cannot yet do anything, I want to sign it in to the AI account I already pay for, so that I am not asked to buy tokens through a middleman to find out whether this works.

A sandbox with no AI account is a very good box with nothing in it, so this is the step that decides whether setup succeeded. Whatever I connect is stored inside my sandbox and never on the platform: that is the whole argument, and any screen that handles it has to be able to say so.

The first one happens in one place, on its own screen, because the question is which of three ways in I want — a free sign-in, a model on this machine, or a subscription I am already paying for — and that is a choice, not a setting. Each way is a lane, and picking one opens it where it stands; the others stay on screen, because a reader who opened the wrong door should not have to go back anywhere. The sign-in itself unfolds in that lane and keeps the whole of it, since it is two steps with a trip to another tab in between. Nothing connects because I looked at it.

Afterwards, the sandbox's Agent tab is where the accounts I have live: who each one signed in as, what it is spending, how to add another or drop one. That tab does not start a first connection any more, and nothing about a connection is kept anywhere but here.

## Acceptance criteria

- [ ] One screen offers the ways in — a free sign-in, a model that runs on this machine, and the subscriptions I might already pay for — with what each costs readable before I connect anything
- [ ] Every surface that offers to connect a model (the composer's line, the model list, the spent-trial notice) leads to that one screen rather than starting a sign-in of its own
- [ ] Picking a way opens it in place and leaves the others reachable; nothing connects because I looked at it
- [ ] Starting a sign-in unfolds its instructions in that lane, with room for the whole instruction, and one way to cancel it
- [ ] The machine's own lane names a model this machine can actually hold, says what it will download and what it will hold while running, and says plainly where a small one is not good enough
- [ ] Connecting ends on this screen saying so, with one press that starts a conversation on what I just connected
- [ ] The sandbox's Agent tab lists the accounts the sandbox holds, naming who each one signed in as, and lets a second be added or one dropped
- [ ] A provider that supports several accounts lets a second one be added, and the two rows can be told apart
- [ ] With no account connected, the product says the agent cannot run yet rather than failing at the first message
- [ ] While the sandbox is unreachable, the tab says so instead of showing controls that silently do nothing
- [ ] After connecting, starting a conversation and sending a message gets a reply from that provider's model
