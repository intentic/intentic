# @intentic-app/capability-catalog

The product catalogs the web app renders from: which capabilities exist, what each one's add-form asks for, and
how its card reads.

## Responsibilities

- Describe every capability as a card and an add-form: label, logo, and the fields a user actually fills in.
- Describe the self-hosted services the infrastructure panel can add.
- Describe the effects a capability has, so the UI can say what turning it on will do.

## Key files

- [src/index.ts](src/index.ts) — the catalogs and their descriptor types.
- [src/effects.ts](src/effects.ts) — what a capability changes once it is on.

## How it fits

**Not a wire contract.** This was moved out of `@intentic-app/api-contract` so that package holds only schemas;
what a form looks like is a product decision, not a protocol. The enums it keys off come from
`@intentic/sandbox-contract`, so the catalog cannot describe a capability the daemon does not have.

## Conventions & gotchas

- Only user-provided, non-secret fields appear in an add-form descriptor. Backends are never added through a bare
  form: servers register themselves via the connect-host command, and Cloudflare goes through its own step.
