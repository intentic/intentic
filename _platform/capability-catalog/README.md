# @intentic-app/capability-catalog

The product catalogs of what a sandbox can be connected to: which capabilities exist, what each one's add-form
asks for, and how its card reads — rendered by the web app, and read by the sandbox daemon to validate an
agent's in-chat ask to connect one.

## Responsibilities

- Describe every capability as a card and an add-form: label, logo, and the fields a user actually fills in.
- Describe the self-hosted services the infrastructure panel can add.
- Describe the effects a capability has, so the UI can say what turning it on will do.
- Join a card to the live connections that came from it (`instancesOf`) — one definition of the discriminator
  rules, shared by the web's Capabilities grid and the daemon's capability ask gate so the two cannot drift.

## Key files

- [src/index.ts](src/index.ts) — the catalogs and their descriptor types.
- [src/effects.ts](src/effects.ts) — what a capability changes once it is on.

## How it fits

**Not a wire contract.** This was moved out of `@intentic-app/api-contract` so that package holds only schemas;
what a form looks like is a product decision, not a protocol. The enums it keys off come from
`@intentic/sandbox-contract`, so the catalog cannot describe a capability the daemon does not have.

**Two readers.** The web renders the whole catalog (cards, forms, effects). The daemon (`@intentic/sandbox`)
reads the card list and the join: an agent's `capabilities request` is validated against it, and the card raised
in the owner's chat takes its title from it — which is what keeps the model unable to retitle what it is asking
for.

## Conventions & gotchas

- Only user-provided, non-secret fields appear in an add-form descriptor. Backends are never added through a bare
  form: servers register themselves via the connect-host command, and Cloudflare goes through its own step.
- Some kinds get **core fields** appended to every card's form (`CORE_FIELDS`), because the fact they capture does
  not vary by card: the connected-computer permission switches, and the browser cards' optional username/password —
  the stored credentials the daemon types into a site when the agent connects the account itself — plus `identity`,
  which files the account into an identity's shared browser (the web narrows it to a picker over the identities
  that exist, and hides it when none do). A card declaring
  one of those keys keeps its own version.
- **A card's `description` is one line — 60 characters or fewer.** The grid puts three or four tiles across what
  is left of the page after the index column, and a row is as tall as its tallest tile, so a sentence with a
  clause after the dash costs height on the two cards beside it as well as its own. Everything longer goes in
  `hint`: the config form prints it in full, and the catalog's free-text search reads it, so a card stays
  findable by words its tile no longer has room to show.
