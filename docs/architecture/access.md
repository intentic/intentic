# Access

Every turn acts for someone, and what it may reach is decided by who that is: the people who wrote in its conversation, or the service an unattended run acts as, each held to an access profile. A persona only shapes how the turn behaves inside that.

```mermaid
flowchart TB
    subgraph chain["Who the conversation acts for (latched, never shrinks)"]
        people["people<br/>everyone who wrote in it"]
        services["services<br/>runAs of an automation, sender rule,<br/>link or control token"]
    end
    services -->|"acts for"| steward["its steward<br/>a person on the roster"]
    people --> hard
    steward --> hard
    services -->|"held to"| profile["its access profile"]
    profile --> hard
    org["organisation ceiling<br/>tools · AI accounts"] --> hard
    hard["Hard reach = intersection of every limit<br/>credentials · AI accounts · tools · fence"]
    hard --> persona["persona narrows<br/>posture: may only remove"]
    persona --> grants["conversation grants lift persona narrowing,<br/>never above hard reach"]
    grants --> gates["credential gates: an approver's click,<br/>inside reach"]
    gates --> turn(["turn"])
```

## Four nouns

- **A principal** is who a turn acts for. A *person* is the owner or someone on the roster ([`members.ts`](../../_shared/sandbox-contract/src/schemas/members.ts)). A *service* ([`services.ts`](../../_shared/sandbox-contract/src/schemas/services.ts)) is a named non-human, such as "Marketing bot" or "Nightly fixer", that a person stewards. Automations, sender rules, inbound links and control tokens run as a service by naming it in `runAs`.
- **An access profile** ([`access-profiles.ts`](../../_shared/sandbox-contract/src/schemas/access-profiles.ts)) is the hard layer: the areas a holder sees and edits, whether their conversations run agents, the connections and secrets they may spend, the AI accounts their turns may run on, a ceiling on tools, and which assistants a guest talks to. It is named and reusable, and one shape serves both kinds of principal, so an intern and the marketing bot can hold the same one. A person holds one profile or answers of their own written on their row. A service holds one profile or none.
- **A persona** is posture: prompt, skills, briefing, preferred models, starting folder and the accounts it speaks through. It can narrow what a turn reaches (a read-only reviewer, a card that only posts as `reddit-work`), and it never widens it.
- **An assistant** is how someone reaches an agent. A guest's assistants are the personas their profile lists, or every persona that works in their areas. An outward assistant (a website chat, a Discord bot) is a listener automation: its persona, the service it runs as, and its sender rules.

## How a turn's reach is worked out

The conversation latches who it acts for as its turns begin ([`identity-latch.ts`](../../_sandbox/sandbox/src/conversations/actor/identity-latch.ts)): `people` grows with each person who asks it for a turn, and `services` with each service a turn runs as. Neither ever shrinks, and a spawned child or a peer's message brings its speaker's along. What the conversation may reach is then the intersection of every limit in that chain ([`principal-chain.ts`](../../_sandbox/sandbox/src/access/principal-chain.ts)), read live on every use:

| Limit | Comes from |
| --- | --- |
| A person | their roster row: the owner and a maintainer every answer, a member what their row says, someone no longer on the roster nothing |
| A service | its steward, as a person above, intersected with its profile. A service, steward or profile that no longer exists reaches nothing |
| The organisation | the ceiling a bound sandbox's policy carries, on tools and AI accounts |

That intersection decides four things, each where the daemon already enforced it for people:

- **Credentials**: a capability outside it is never mounted, its variables and skill are left out, and every exit that spends a secret refuses it ([`credential-reach.ts`](../../_sandbox/sandbox/src/secrets/credential-reach.ts)).
- **AI accounts**: a turn naming an account outside it is refused, one left to the sandbox's pick runs inside it, and a conversation remembering one outside it is moved ([`account-reach.ts`](../../_sandbox/sandbox/src/agent/run/decide/account-reach.ts)).
- **Tools**: the ceiling caps the persona's shelves after conversation grants are laid over them, so neither a card nor a grant lifts a shelf the chain withholds ([`turn-premise.ts`](../../_sandbox/sandbox/src/agent/run/decide/turn-premise.ts)). An agent asking for such a shelf with `grants request` is refused rather than shown a card, since no answer could open it.
- **The fence**: a conversation is born inside its starter's areas. A service's run is born inside its steward's areas intersected with its profile's, as area ids.

## Services

A service always acts for its steward, so the oldest rule here still holds for unattended work: an agent never holds more than the person it acts for. A steward is the owner or someone on the roster who runs agents here. The profile narrows that further, and naming one is how unattended work stops reaching everything its steward can.

- Before a fire starts a turn, the daemon checks the service still stands ([`service-standing.ts`](../../_sandbox/sandbox/src/access/service-standing.ts)). One whose steward left the roster, or whose service or profile was deleted, is recorded as skipped with that reason rather than run on nothing.
- An automation save is refused when its persona speaks through an account its service's profile leaves out, or when none of the models it may run on is an AI account the service may use: the run could only fail.
- `runAs` left out keeps what unattended work always did: it acts for the sandbox's owner with no profile, and the No accounts posture keeps signed-in accounts away from it.

## Profiles on a person

A member's row holds either answers of its own or `profile: <id>`. A row holding a profile carries that profile's answers written out on it, so every reader of the row (the route floors, the authorizer, the platform's copy of the tier, the presence list) reads one shape. Saving a profile rewrites the rows of everyone who holds it and closes their open sockets, as a re-grade does, and answers with each holder's tier so the editor can bring the platform's copy along. A profile cannot make a maintainer: that tier holds the owner's operating authority and is granted to a person, never through something shared.

## Where it is stored

Profiles and services are on the history volume beside the roster (`identity/access-profiles.json`, `identity/services.json`), and they do not travel with an export bundle. An automation that arrives in another sandbox naming a service that sandbox lacks is skipped with that reason until someone gives it one there.

## Organisations

A bound sandbox's policy may carry profiles of its own and a ceiling ([`organisation.ts`](../../_shared/sandbox-contract/src/schemas/organisation.ts)). The organisation's profiles are listed beside the sandbox's own as read-only, and a local profile cannot take one of their ids. The ceiling (tool shelves switched off, the AI accounts every turn is held to) is one more limit in every turn's chain, the owner's included. Writing profiles and services counts as a change to the Access section, so locking Access locks them too ([`org-locks.ts`](../../_shared/sandbox-contract/src/policy/org-locks.ts)).

## Decisions

- **Posture and access are two things** (2026-10-26). Before this, a persona was soft for a watched chat and the only boundary for an unattended one, since a run with no person in its conversation reached every credential and every AI account. The same card meant two things depending on whether anyone was watching, and an automation had no owner to answer for it.
- **A service acts for a person** (2026-10-26). The alternative was a service with authority of its own. Tying it to a steward keeps one rule for all work, makes a leaver's automations stop by construction, and gives spending and audit a person to name.
- **One profile per principal** (2026-10-26), not a union of several: `agents` (off, chat, run, home) has no union that means anything. Sharing one profile between holders is the reuse.
- **Written onto the row** (2026-10-26). Reading a member's profile live at every request was the alternative. Every reader of the roster, the platform's copy of the tier included, would then have had to learn profiles at once, and a profile edit would have moved tiers with nothing telling the platform.
- **Off the workspace** (2026-10-26), unlike areas, which are tracked so their edits show up in review. A profile bounds unattended runs, and a run that could edit the file bounding it would hold nothing; the roster left the workspace on 2026-10-06 for the same reason.
- **The built-in personas stay, as postures** (2026-10-26). The first sketch removed Full access and No accounts. Automations and links already name them, and once the ceiling comes from the chain they are exactly the two postures worth having built in.
- **No separate assistant record** (2026-10-26). An outward assistant is already a listener automation (persona, `runAs`, sender rules), and an inward one is a persona a profile lists. A third record would have said the same thing twice. Under a guest's own authority the guest's fence still has to hold an assistant's starting folder, so a listed assistant must work in the guest's areas.

## Key files

- [access-profiles.ts](../../_shared/sandbox-contract/src/schemas/access-profiles.ts): the profile, its tool ceiling and how it caps a persona's shelves.
- [services.ts](../../_shared/sandbox-contract/src/schemas/services.ts): the service principal.
- [principal-chain.ts](../../_sandbox/sandbox/src/access/principal-chain.ts): who a conversation acts for, resolved to limits.
- [credential-reach.ts](../../_sandbox/sandbox/src/secrets/credential-reach.ts): credentials and AI accounts within the chain.
- [service-standing.ts](../../_sandbox/sandbox/src/access/service-standing.ts): whether a service may still run.
