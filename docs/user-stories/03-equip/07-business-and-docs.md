# Be told what a capability depends on, instead of discovering it

As someone connecting payments and a knowledge base, I want a card that needs something else first to say so up front, so that I do not fill in a form whose save can only be refused.

Some capabilities are not standalone. Payments here ride on the DevOps capability, because the credential is read from the sandbox's environment when it next provisions. That is a real dependency and a strange one to guess at, so the card carries it in the catalog (visible before I open it) and the form refuses to render its fields until the prerequisite is active, saying which one it is and where to activate it.

The wiki side has no such dependency and should not pretend to: it is an instance URL and a key, like any other connector. What both share is that the payoff is in a conversation, where the agent reads a document or looks up a customer without me copying anything across.

## Acceptance criteria

- [ ] The Business & docs section lists the payment and knowledge-base cards with a line saying what the agent gains
- [ ] A card with a prerequisite shows that prerequisite on the card in the catalog, before it is opened
- [ ] Opening a card whose prerequisite is not active shows what is needed and where to activate it, instead of a form
- [ ] Once the prerequisite is active, the same card opens on its own form
- [ ] The knowledge-base card takes an instance URL and its key, with the key masked
- [ ] Any hint about where a credential comes from, or when it takes effect, is stated on the card rather than left to be discovered
- [ ] A connected instance appears under Connected with its state, and the catalog card reflects that it has one
- [ ] With a connection active, asking the agent to look something up in that service returns real data
