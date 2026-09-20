# Connect payments and a knowledge base, and have the agent use them

As someone connecting Stripe and a wiki, I want each card to ask for a credential and nothing else, so that connecting one is a paste and the payoff shows up in the next conversation.

Nothing in Business & docs stands on anything else. Payments is a key; the wiki is an instance URL and a key. Each writes a cheatsheet the agent reads and puts the credential in its environment for the turn, so the agent looks up a customer or reads a document without me copying anything across.

What a card owes me before I fill it in is where the credential comes from and what it costs: which page of the provider issues it, which scopes it needs, and whether a narrower one will do. Payments says a restricted read key is enough unless the agent has to charge — that is a choice worth making before pasting, not after.

## Acceptance criteria

- [ ] The Business & docs section lists the payment and knowledge-base cards with a line saying what the agent gains
- [ ] Each card opens straight onto its own form: nothing here has a prerequisite to activate first
- [ ] The knowledge-base card takes an instance URL and its key, with the key masked
- [ ] The payment card takes a key alone, masked, and says which provider page issues one and which scopes it needs
- [ ] Any hint about where a credential comes from, or how narrow it can be, is stated on the card rather than left to be discovered
- [ ] Saving runs one authenticated request against the service, so a wrong key is answered on the form rather than by a card that later reads "not connected"
- [ ] A connected instance appears under Connected with its state, and the catalog card reflects that it has one
- [ ] With a connection active, asking the agent to look something up in that service returns real data
