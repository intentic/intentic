# Give the agent a brain, on my own subscription

As someone whose sandbox is up but cannot yet do anything, I want to sign it in to the AI account I already pay for, so that I am not asked to buy tokens through a middleman to find out whether this works.

A sandbox with no AI account is a very good box with nothing in it, so this is the step that decides whether setup succeeded. Whatever I connect is stored inside my sandbox and never on the platform: that is the whole argument, and any screen that handles it has to be able to say so.

Every model this sandbox can run on lives in one place, Sandbox ▸ Models, beside its environment and its secrets, because what I connect is something the box holds. It is a grid of tiles, one per provider and one for models on this machine, always in the same places, as peers: none is promoted by where it sits, and the free ones (a Google sign-in, my own machine) carry a small "Free" label. Each tile says how many accounts it holds and whether any of them needs me. Pressing one opens its panel below the grid, and that panel is the only place its accounts live and the only way to connect it: what it needs and what it runs, its accounts, and one button that connects it or adds another. Nothing connects because I looked at it.

A sign-in is two steps with a trip to another tab in between, and it unfolds inside the panel of the provider it is for, under the accounts it is adding to. If I wander off before finishing, the chat says so above the composer, with one press back to that panel and one to cancel it there and then. Only one sign-in runs at a time: opening another provider while one waits says so, with the way back to it, and connecting there replaces it. A sign-in that does not start, expires or is refused says which provider it was and why, on its tile, in its panel and in the chat, until I try again or dismiss it.

If I already use an AI tool on this computer (Claude Code, Codex, Gemini CLI, opencode, Hermes, OpenClaw), the desktop app has noticed, and that screen leads with what it found, above the grid. A subscription is one press: the sandbox signs in on its own and my browser, already signed in, only asks me to allow it. Nothing is copied out of the tool, because these logins renew with a token that works once, and a copy would sign either the tool or the sandbox out. A plain API key in those tools' files is different: it is copied into the sandbox as a model I can pick, and the screen shows only its last four characters.

Afterwards the grid is also the overview: a tile's count and dot say what it holds and whether anything needs me (an account to sign in to again, one to verify, a seat only an admin can restore), and a tile that needs me opens by itself when I arrive. Its panel lists who each account signed in as, what it is spending, and how to drop one. The Local models panel holds this machine's models and any server or key the sandbox is pointed at, and it is the one place that offers pointing at an Ollama or vLLM server I already run. Ollama or LM Studio running on the computer that hosts the sandbox is already listed there, one press from being used; that is how a model uses my GPU, since the sandbox's own local models run on its CPU. The sandbox's menu shows a count on Models when something there needs me, so I do not have to open it to find out. Which model does which job (commit messages, titles, the safety judge) is the Agent's Jobs tab, which picks from what Models holds.

## Acceptance criteria

- [ ] Sandbox ▸ Models is in the sandbox's menu and the command palette, and every place that offers to connect a model leads there; an old `/connect` link still arrives
- [ ] One grid offers every provider and this machine as equal tiles in a fixed order, the free ones labelled "Free", with what each needs and runs readable in its panel before I connect anything
- [ ] Each tile says how many accounts (or models) it holds, and a dot says whether any of them needs me; tiles are the same size whatever they say
- [ ] A provider's panel is the only way to connect it: one button when it holds nothing, "Add another account" in its header once it holds one (one button per way in for a provider with two, named for each)
- [ ] Every surface that offers to connect a model (the composer's line, the model list, the spent-trial notice) leads to that one screen rather than starting a sign-in of its own
- [ ] On a computer where the desktop app found an AI tool signed in, the screen first offers each subscription it found as one press, and says the tool keeps its own login
- [ ] API keys found in those tools' files are offered as models to add, named by provider and where they came from, never shown whole; an added one is in the model list at once
- [ ] The desktop app tells the workspace only the ids of what it found; the keys are read by my own sandbox through my paired computer, and one becomes a model only when I press Add
- [ ] Pressing a tile opens its panel below the grid and leaves every other tile pressable; nothing connects because I looked at it
- [ ] Starting a sign-in opens its instructions inside that provider's panel, with room for the whole instruction and one way to cancel it, and its tile says "Signing in…"
- [ ] While a sign-in runs, another provider's panel says one is waiting, offers the way back to it, and connecting there replaces it
- [ ] A sign-in left unfinished shows above the composer with Finish sign-in, which returns to the page with that provider's panel open, and Cancel, which ends it from there
- [ ] A sign-in that fails to start, expires or is refused names the provider and the reason, on the screen and above the composer, with Try again and Dismiss
- [ ] A provider sold under several plans asks which one before its sign-in starts
- [ ] The Local models panel names a model this machine can actually hold, says what it will download and what it will hold while running, and says plainly where a small one is not good enough
- [ ] Connecting ends on this screen saying so, with one press that starts a conversation on what I just connected
- [ ] A provider's panel names who each account signed in as and lets one be dropped; a tile whose accounts need me opens by itself on arrival
- [x] Pointing at an Ollama or vLLM server is offered in the Local models panel and nowhere else on the page
- [x] Ollama or LM Studio running on the computer hosting the sandbox is listed in the Local models panel and added with one press, and what it serves stays on that computer as far as the privacy shield is concerned
- [ ] Adding a second account finishes only when that account arrives, never because the provider already had one
- [ ] The sandbox's menu counts what on Models needs a person, and marks a sign-in in progress
- [ ] Agent ▸ Jobs chooses which model does each job from what Models holds
- [ ] A provider that supports several accounts lets a second one be added, and the two rows can be told apart
- [ ] With no account connected, the product says the agent cannot run yet rather than failing at the first message
- [ ] While the sandbox is unreachable, the page says so instead of showing controls that silently do nothing
- [ ] Someone who may not connect models (below maintainer) is told who can, rather than sent to a page that will not open
- [ ] After connecting, starting a conversation and sending a message gets a reply from that provider's model
