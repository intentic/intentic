# Organisations

An organisation is a set of people and the sandboxes they run, all held to one policy that the organisation's admins write. It exists for an office of 20 to 200 people who do not write code, with a small IT department: a Polish municipal office is the case it was designed against. Personal sandboxes stay exactly as they are. Nothing here applies to a sandbox unless an admin who owns it has added it to an organisation.

```mermaid
flowchart LR
    admin["Org admin<br/>Settings ▸ Organisation"] -->|"/rpc org.*"| api(["platform api"])
    api --> db[("Postgres<br/>organisation · org_member<br/>sandbox.orgId")]
    daemon["Sandbox daemon<br/>(bound sandbox)"] -->|"POST /sandbox/org-policy<br/>connect token, every 5 min"| api
    daemon --> file["auth root<br/>org-policy.json"]
    daemon -->|"403 org-locked"| caller["owner · member · agent token · panel"]
    editor["Sandbox hub"] -->|"GET /org/policy"| daemon
```

## Phase 1, as built

### Data model

[`schema.prisma`](../../_platform/prisma/schema.prisma), migration `20261013120000_organisations`:

- `Organisation`: a name, the policy rules as JSON (`policy`), and `policyVersion`, which goes up by one on every save.
- `OrgMember`: a person in an organisation, keyed by lowercased email like `SandboxMember`, so a person can be listed before they ever sign in. `role` is `admin` or `member` (`OrgRoleSchema`, stored as a string, so adding a role needs no migration).
- `Sandbox.orgId`: the organisation a sandbox belongs to. Null means personal, which is every existing sandbox. If the organisation is deleted, the column is set back to null, so its sandboxes become personal again rather than disappearing. `Sandbox.orgPolicyApplied` records the policy version the sandbox's daemon last reported holding.

The sandbox owner is still a person. An organisation does not own the machine or the connect token. It holds the sandbox to a policy, and the owner is held to that policy like everyone else.

### Who can do what

The routes are `org.*` in [`api-contract/organisations.ts`](../../_shared/api-contract/src/organisations.ts), served by [`org.routes.ts`](../../_platform/api/src/org/org.routes.ts).

| Action | Who |
| --- | --- |
| Start an organisation | The deployment's operators (`ADMIN_EMAILS`, proven the way `ADMIN_SIGN_IN` requires), or anyone signed in when `ORGS_CREATION=anyone`. The creator becomes its first admin. |
| Read the policy | Any member. Only admins also see the member list and the sandboxes. |
| Save a new policy version | Admins. Each save names the version it was edited from. If someone saved in between, the save is refused with `CONFLICT`, so one admin cannot silently undo another's change. |
| Add or remove people | Admins. The last admin cannot be removed. |
| Add a sandbox (bind) | An admin who owns that sandbox. Binding constrains the owner, so it is never done to a sandbox by someone else. |
| Release a sandbox (unbind) | Admins. If the owner could unbind alone, every lock would be optional. The owner can still delete the sandbox, since the machine is theirs. |

A caller who is not in an organisation gets the same `NOT_FOUND` as for one that does not exist, so an id reveals nothing.

### The policy

[`schemas/organisation.ts`](../../_shared/sandbox-contract/src/schemas/organisation.ts) defines the policy. For each lockable part of a sandbox it sets one mode:

- `open`: works the same as in a personal sandbox. A part the policy leaves out is open.
- `locked`: anyone can read it, but every change is refused, including the sandbox owner's and the agent's.
- `hidden`: locked, and also removed from the sandbox hub and the command palette. Reads that would show a value to a person (`secrets.reveal`, `privacy.reveal`) are refused too. Hidden controls what people see, not what the sandbox uses: the agent still uses the secrets of a hidden Secrets section.

The lockable parts are the hub sections `models`, `agent`, `environment`, `secrets` (secrets and connections), `data-protection`, `extensions`, `access`, `areas` and `personas`, plus `updates`, the auto-update switch on Overview. Overview, Usage and Audit are not lockable: they report on the sandbox and change nothing an organisation needs to hold.

[`policy/org-locks.ts`](../../_shared/sandbox-contract/src/policy/org-locks.ts) lists which daemon routes each part covers, route by route rather than by contract group. A group mixes the changes a lock is meant to stop with operations it should leave alone: probing a connection, asking a named person to release a credential (`secrets.request`), confirming your own AI-literacy notice, leaving a sandbox (`DELETE /members/self`), and teaching the privacy shield more values. The side effect is that a route added later stays open until someone lists it, and that omission shows up in the file's diff. A test checks every listed name against the route tables, so renaming a route cannot leave a lock pointing at nothing.

A platform reads a stored mode it does not recognise as `locked`, so a newer platform's stricter setting is never read as open.

### Delivery

The policy reaches a sandbox over the same channel as its announce: the sandbox's own connect token, on the ingress route `orgPolicy` (`POST /sandbox/org-policy`). The daemon ([`org/org-policy.ts`](../../_sandbox/sandbox/src/org/org-policy.ts)) asks at boot and every five minutes after, and says which version it already holds. The platform records that in `orgPolicyApplied`, and the console shows each sandbox as "in force" or "waiting". A separate route is used instead of the announce answer because the announce repeats only every hour and is shared by every daemon release. A lock an admin sets reaches every sandbox within five minutes.

- The answer is `{ policy }` or `{ policy: null }`. Null is the platform saying the sandbox belongs to no organisation, and it is the only answer that unbinds one. A refusal, an answer that cannot be read, or a platform that cannot be reached all keep the policy the daemon already holds. Cutting a bound sandbox off from the platform never loosens it.
- A newer version replaces an older one, and an older one is ignored. A policy from a different organisation replaces the current one outright, since only the platform can move a sandbox between organisations.
- The daemon keeps the policy in `org-policy.json` in the auth root, beside the sandbox's other trust files and outside the workspace the agent edits. A restart while the platform is down still enforces the last version.

### Enforcement

[`org-locks.middleware.ts`](../../_sandbox/sandbox/src/org/org-locks.middleware.ts) is mounted in the daemon's [`app.ts`](../../_sandbox/sandbox/src/app.ts) after authentication. It applies to every credential the same way: the owner, a member, the agent's token, a panel token, a control token, and a loopback daemon with no sign-in at all. A refused request gets `403 { error, reason: "org-locked", section, org }`. A personal sandbox holds no policy, so the middleware costs it one resolved promise and then passes the request on. The only way to lift a lock is to change the policy on the platform. Nothing inside the sandbox can.

The platform enforces the policy in one place of its own. The invite routes (`invite.create`, `resend`, `setRole`, `revoke`) refuse a sandbox whose organisation holds Access. Without that, the platform's copy of the roster could drift away from the daemon's frozen one.

### The editor

- The sandbox hub reads the policy from the daemon (`GET /org/policy`, [`useOrgPolicy.ts`](../../_editor/web/src/features/organisations/useOrgPolicy.ts)) rather than from the platform, so it draws what the daemon will actually refuse. A hidden section is removed from the hub index and the palette. A locked section is wrapped in [`OrgHeldSection.vue`](../../_editor/web/src/features/organisations/OrgHeldSection.vue), which shows "{org} manages this part of the sandbox" and puts the section inside a disabled `<fieldset>`. That disables every control in the section at once, without each page having to know about organisations. A daemon too old to have the route reads as unbound.
- Settings ▸ Organisation ([`OrgConsole.vue`](../../_editor/web/src/features/organisations/OrgConsole.vue), [`OrgDetailPanel.vue`](../../_editor/web/src/features/organisations/OrgDetailPanel.vue)) is the organisation admin's console. It lists the organisations you are in, lets you start one where the platform allows it, edits the policy section by section and saves it as a new version, manages the people, and binds and releases sandboxes with each one's applied or waiting state. A member sees the policy as read-only text.
- The `updates` lock has no UI of its own yet. The Overview switch is still drawn, and the daemon refuses the change.

### Limits of phase 1

- A lock covers the daemon's routes, not the files behind them. An agent with a shell can still edit `.intentic/config/*.json` directly. Phase 2 closes this: the daemon re-asserts locked documents on read and records drift.
- The held policy is not signed. Someone who is root in the container can delete `org-policy.json` and, while the platform is unreachable, run unbound until the next fetch succeeds. Phase 2 signs the policy with the platform's identity key, which every daemon already learns from its announce.
- Hiding a section refuses the reveal routes, but other reads still answer. That is deliberate: other parts of the editor depend on those reads.

## Later phases

### Phase 2: hardening and settings-level locks

- Sign the policy (Ed25519, the identity signing key) and have the daemon refuse a held file it cannot verify. On a self-hosted platform without `IDENTITY_SIGNING_KEY`, keep phase 1's behaviour and show a warning in the console.
- Pinned values, not just locked sections: `requirePublicOfficePreset` makes the daemon apply the chosen items of the public-office preset ([`compliance/preset.ts`](../../_sandbox/sandbox/src/compliance/preset.ts)) and refuse to undo them. Per-key pins on `settings.json` (for example the privacy shield, or the agent execution domain) are refused by `settings.set` when the write would change a pinned key.
- File-level enforcement: the daemon's document reads overlay pinned values, and an edit made outside the routes shows up in the audit trail as drift.

### Phase 3: central personas and assistant templates

An organisation keeps persona cards and kits on the platform as a versioned bundle, in the same shape as `.intentic/config/personas.json`. Bound daemons fetch it beside the policy and install the cards as org-owned and read-only (`origin: org`), next to the sandbox's own cards. The `personas` lock then means "only the organisation's cards".

### Phase 4: provisioning

- Bulk invite: paste or upload a CSV of addresses with a department and a role. The platform creates the `OrgMember` rows and sends one email each.
- From organisation member to sandbox access: an admin sets a department's default sandbox, role and area. The platform sends the grant to the daemon through a new admin-signed route, so a locked Access section has a managed way in. `SandboxMember` and the daemon's roster stay the enforced copies.
- Sandbox creation for the organisation: `sandboxes` / `fleet.provision` take an `orgId`, so IT can create one sandbox per clerk, already bound, without creating them one by one.
- Identity: `Organisation` gets an optional identity-provider binding (OIDC issuer, allowed email domains). SSO is decided separately; the model leaves room for it.

### Phase 5: usage attribution and budgets

- The spend ledger ([`providers/usage.ts`](../../_shared/sandbox-contract/src/schemas/providers/usage.ts)) gains the member email and department on each turn. The daemon already knows who started a turn.
- A bound daemon reports daily per-member totals over the connect token. The organisation console shows them by member, department and sandbox.
- Budgets per member and per department, delivered in the policy and enforced at turn admission, the same place the trial allowance is checked. A turn over budget is refused before it starts, with a message naming the budget. `maxSpendUsd` on loops stays as it is.

### Phase 6: update control

Policy fields `updates: { channel, freeze, rolloutPercent }`. The daemon's update policy ([`update-policy.ts`](../../_sandbox/sandbox/src/system/updates/update-policy.ts)) reads them before its own switch, and the platform answers `ic` with the pinned image for a frozen organisation. A staged rollout starts with an organisation's pilot sandboxes, chosen by a tag.

## Decisions taken without the owner

These were decided while building and are open to revision:

- **Organisations exist on the hosted platform and on a self-hosted one alike, but only operators can start them by default** (`ORGS_CREATION=operators`). The feature is in the product, but it does not appear on app.intentic.dev for everyone until pricing is decided. A self-hosted office sets `anyone` or lists its IT staff in `ADMIN_EMAILS`. Pricing and plan limits are not modelled.
- **The organisation does not own the sandbox.** Ownership, the connect token and deletion stay with a person. An organisation controlling the machine is a larger change, possibly with phase 4's creation-for-the-organisation.
- **Locks are per section, not per member tier.** A section an organisation hides is hidden from everyone in the sandbox, the owner included. Organisation admins manage it from the console, not from inside the sandbox.

## Migration

The migration only adds things. Existing sandboxes have `orgId` null, and their daemons are answered `{ policy: null }`, so nothing changes for them. A daemon older than this release never asks for a policy, and the platform holds it to nothing. Before binding a sandbox, check that its daemon reports holding the policy. A platform older than this release answers the daemon's fetch with 404, which the daemon reads as "keep what is held", so a personal sandbox stays personal.
