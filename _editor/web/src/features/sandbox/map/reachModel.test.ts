import type { ControlTokenSummary } from "@intentic/sandbox-contract/policy/control-scopes";
import type { Area } from "@intentic/sandbox-contract/schemas/areas";
import type { InboundLinkSummary, LinkTerms } from "@intentic/sandbox-contract/schemas/links";
import type { Member } from "@intentic/sandbox-contract/schemas/members";
import { type Persona, PersonaPowersSchema } from "@intentic/sandbox-contract/schemas/personas";
import { buildReachMap, bundleId, holdersOf, lightingOf, type Principal, type ReachCapability, type ReachInput, relationsOf } from "./reachModel";

// The workspace the cases share: two areas, three personas homed in each and at the root, and a connection of each kind
// a rule decides differently. Every case asks the map what the daemon would let one principal do.

const NOW = 1_800_000_000_000;

const areas: Area[] = [
    { id: `support`, label: `Support desk`, folders: [`web/support`] },
    { id: `site`, label: `Marketing site`, folders: [`web/site`] },
];

const personas: Persona[] = [
    { id: `maya`, label: `Maya`, capabilities: [`gmail-support`], workspace: { startIn: `web/support`, folders: [`web/support`] } },
    { id: `owen`, label: `Owen`, capabilities: [`x-brand`], workspace: { startIn: `web/site` }, powers: PersonaPowersSchema.parse({ connectors: [`github`] }) },
    { id: `priya`, label: `Priya`, capabilities: [] },
];

const capability = (id: string, kind: ReachCapability[`kind`], extra: Partial<ReachCapability> = {}): ReachCapability => ({
    id,
    kind,
    title: id,
    icon: `bolt`,
    state: `Connected`,
    tone: `success`,
    ...extra,
});

const capabilities: ReachCapability[] = [
    capability(`github`, `cli`),
    capability(`postgres`, `cli`, { tone: `danger`, state: `Error` }),
    capability(`gmail-support`, `browser`, { identity: `support-id` }),
    capability(`x-brand`, `browser`),
    capability(`support-id`, `identity`),
    capability(`docker`, `docker`),
    capability(`ops-box`, `link`),
];

const member = (row: Member): Member => row;

const input = (over: Partial<ReachInput> = {}): ReachInput => ({
    areas,
    personas,
    capabilities,
    secrets: [`SENTRY_DSN`, `STRIPE_KEY`],
    models: [{ id: `model:claude`, label: `Claude`, tone: `success` }],
    roster: {
        owner: `ada@acme.dev`,
        members: [
            member({ email: `jo@acme.dev`, role: `collaborator`, credentials: { capabilities: [`github`], secrets: [`SENTRY_DSN`] } }),
            member({ email: `sam@acme.dev`, role: `guest`, areas: [`support`] }),
            member({ email: `rin@acme.dev`, role: `viewer` }),
            member({ email: `wes@acme.dev`, role: `writer`, areas: [`site`, `support`], edit: [`site`] }),
            member({ email: `max@acme.dev`, role: `maintainer` }),
        ],
    },
    self: { email: `ada@acme.dev`, role: `owner` },
    now: NOW,
    ...over,
});

const principal = (map: ReturnType<typeof buildReachMap>, id: string): Principal => {
    const found = map.principals.find((entry) => entry.id === id);
    if (found === undefined) {
        throw new Error(`no principal ${id}`);
    }
    return found;
};

const reached = (who: Principal): Record<string, string> => Object.fromEntries([...who.reach].toSorted(([left], [right]) => left.localeCompare(right)));

describe(`people`, () => {
    it(`puts the reader first and the owner's reach is everything, editing every area`, () => {
        const map = buildReachMap(input());
        expect(map.principals.map((entry) => entry.id).slice(0, 2)).toEqual([`person:ada@acme.dev`, `person:max@acme.dev`]);
        const owner = principal(map, `person:ada@acme.dev`);
        expect(owner.self).toBe(true);
        expect(owner.reach.get(`area:support`)).toBe(`edit`);
        expect(owner.reach.get(`rest`)).toBe(`edit`);
        expect(owner.reach.get(`cap:x-brand`)).toBe(`use`);
        expect(owner.reach.get(`persona:priya`)).toBe(`use`);
    });

    // Credential reach withholds only the kinds it decides: a connector off the list is out, docker never was a credential.
    it(`holds a collaborator to the credentials on their row, whole workspace seen and nothing edited`, () => {
        const jo = principal(buildReachMap(input()), `person:jo@acme.dev`);
        expect(reached(jo)).toEqual({
            "area:site": `see`,
            "area:support": `see`,
            "cap:docker": `use`,
            "cap:github": `use`,
            "model:claude": `use`,
            "persona:maya": `use`,
            "persona:owen": `use`,
            "persona:priya": `use`,
            rest: `see`,
            "secret:SENTRY_DSN": `use`,
        });
    });

    // A guest talks to the cards its areas hold and reaches only what those cards act through.
    it(`gives a guest only its area, the persona living there, and what that persona carries`, () => {
        const sam = principal(buildReachMap(input()), `person:sam@acme.dev`);
        expect(reached(sam)).toEqual({
            "area:support": `see`,
            "cap:docker": `through`,
            "cap:github": `through`,
            "cap:gmail-support": `through`,
            "cap:ops-box": `through`,
            "cap:postgres": `through`,
            "model:claude": `through`,
            "persona:maya": `use`,
            "secret:SENTRY_DSN": `through`,
            "secret:STRIPE_KEY": `through`,
        });
    });

    it(`lets a viewer see the workspace and reach nothing an agent would spend`, () => {
        const rin = principal(buildReachMap(input()), `person:rin@acme.dev`);
        expect(reached(rin)).toEqual({ "area:site": `see`, "area:support": `see`, rest: `see` });
    });

    it(`tells where a writer edits from where they only look`, () => {
        const wes = principal(buildReachMap(input()), `person:wes@acme.dev`);
        expect(wes.reach.get(`area:site`)).toBe(`edit`);
        expect(wes.reach.get(`area:support`)).toBe(`see`);
        expect(wes.reach.has(`rest`)).toBe(false);
        // Owen lives in the site, Maya in support; Priya lives at the root, which only the unfenced hold.
        expect(wes.reach.has(`persona:owen`)).toBe(true);
        expect(wes.reach.has(`persona:priya`)).toBe(false);
    });

    it(`marks an invite not yet taken up and one that ran out`, () => {
        const map = buildReachMap(input({ invited: new Set([`rin@acme.dev`]), expired: new Set([`jo@acme.dev`]) }));
        expect(principal(map, `person:rin@acme.dev`).status).toBe(`invited`);
        expect(principal(map, `person:jo@acme.dev`).status).toBe(`inert`);
    });

    // Below the owner the roster is unreadable, and the reader still stands on the map as themselves.
    it(`draws a maintainer who cannot read the roster as themselves alone`, () => {
        const map = buildReachMap(input({ roster: undefined, self: { email: `max@acme.dev`, role: `maintainer` } }));
        expect(map.rosterRead).toBe(false);
        expect(map.principals.filter((entry) => entry.kind === `person`).map((entry) => entry.label)).toEqual([`max@acme.dev`]);
        expect(principal(map, `person:max@acme.dev`).reach.get(`cap:postgres`)).toBe(`use`);
    });
});

describe(`control tokens`, () => {
    const token = (over: Partial<ControlTokenSummary>): ControlTokenSummary => ({ id: `t`, label: `ci`, scope: `drive`, createdAt: 0, ...over });

    it(`reaches by its rung: read sees, drive acts, editor acts inside its one conversation`, () => {
        const map = buildReachMap(
            input({ tokens: [token({ id: `r`, scope: `read` }), token({ id: `d`, scope: `drive` }), token({ id: `e`, scope: `editor` })] }),
        );
        expect(reached(principal(map, `token:r`))).toEqual({ "area:site": `see`, "area:support": `see`, rest: `see` });
        expect(principal(map, `token:d`).reach.get(`cap:x-brand`)).toBe(`use`);
        expect(principal(map, `token:d`).reach.get(`area:site`)).toBe(`see`);
        expect(principal(map, `token:e`).reach.get(`cap:github`)).toBe(`through`);
        // The strongest rung first.
        expect(map.principals.filter((entry) => entry.kind === `token`).map((entry) => entry.scope)).toEqual([`drive`, `editor`, `read`]);
    });

    it(`holds nothing once it expired or its minter lost the operating tier`, () => {
        const map = buildReachMap(
            input({
                tokens: [
                    token({ id: `old`, expiresAt: NOW - 1 }),
                    token({ id: `orphan`, createdBy: `jo@acme.dev` }),
                    token({ id: `kept`, createdBy: `max@acme.dev` }),
                ],
            }),
        );
        expect(principal(map, `token:old`).status).toBe(`inert`);
        expect(principal(map, `token:old`).reach.size).toBe(0);
        expect(principal(map, `token:orphan`).status).toBe(`inert`);
        expect(principal(map, `token:orphan`).inert).toBe(`minter`);
        expect(principal(map, `token:kept`).status).toBe(`active`);
    });
});

describe(`linked sandboxes`, () => {
    const link = (id: string, actsAs?: string): InboundLinkSummary => {
        const terms: LinkTerms = { approve: false, turnsPerHour: 20 };
        if (actsAs !== undefined) {
            terms.actsAs = actsAs;
        }
        return { id, label: id, terms, createdAt: 0, conversations: 0, requests: [] };
    };

    it(`works as its persona, inside that persona's folders`, () => {
        const map = buildReachMap(input({ inbound: [link(`ops`, `maya`)] }));
        expect(reached(principal(map, `link:ops`))).toEqual({
            "area:support": `see`,
            "cap:docker": `through`,
            "cap:github": `through`,
            "cap:gmail-support": `through`,
            "cap:ops-box": `through`,
            "cap:postgres": `through`,
            "model:claude": `through`,
            "persona:maya": `use`,
            "secret:SENTRY_DSN": `through`,
            "secret:STRIPE_KEY": `through`,
        });
    });

    // Nobody is watching a link's task: with no persona named it holds no signed-in account, and everything else.
    it(`holds no signed-in account when it names no persona, and nothing when its persona is gone`, () => {
        const map = buildReachMap(input({ inbound: [link(`open`), link(`lost`, `gone`)] }));
        const open = principal(map, `link:open`);
        expect(open.reach.has(`cap:gmail-support`)).toBe(false);
        expect(open.reach.has(`cap:support-id`)).toBe(false);
        expect(open.reach.get(`cap:github`)).toBe(`use`);
        expect(open.reach.get(`rest`)).toBe(`see`);
        expect(principal(map, `link:lost`).status).toBe(`inert`);
        expect(principal(map, `link:lost`).reach.size).toBe(0);
    });
});

describe(`the drawing`, () => {
    it(`groups connections by what they are, trouble first`, () => {
        const map = buildReachMap(input({ publicPorts: [{ port: 3000, title: `web` }], outboxFiles: 2, anonymousBrowser: true }));
        expect(map.groups.map((group) => [group.key, group.nodes.map((node) => node.id)])).toEqual([
            [`services`, [`cap:postgres`, `cap:github`]],
            [`accounts`, [`cap:gmail-support`, `cap:support-id`, `cap:x-brand`, `session:anonymous`]],
            [`machines`, [`cap:docker`]],
            [`sandboxes`, [`cap:ops-box`]],
            [`network`, [`port:3000`, `outbox`]],
            [`models`, [`model:claude`]],
        ]);
        expect(map.areas.map((node) => node.id)).toEqual([`area:support`, `area:site`, `rest`]);
    });

    it(`names who reaches a node`, () => {
        const map = buildReachMap(input());
        expect(holdersOf(map, `cap:gmail-support`).map(({ principal: who, how }) => `${who.label}:${how}`)).toEqual([
            `ada@acme.dev:use`,
            `max@acme.dev:use`,
            // A writer runs agents with no persona named, so their turns hold every account.
            `wes@acme.dev:use`,
            `sam@acme.dev:through`,
        ]);
    });

    it(`threads a persona to the accounts it carries, and lights where it works`, () => {
        const { lit, threads } = relationsOf(input(), `persona:maya`);
        expect(threads).toEqual([`cap:gmail-support`]);
        expect(lit.has(`area:support`)).toBe(true);
        expect(lit.has(`area:site`)).toBe(false);
        // Owen carries only the connectors listed on his shelf.
        expect(relationsOf(input(), `persona:owen`).lit.has(`cap:postgres`)).toBe(false);
    });

    it(`threads an area to the personas living in it, and the rest to the ones at the root`, () => {
        expect(relationsOf(input(), `area:site`).threads).toEqual([`persona:owen`]);
        expect(relationsOf(input(), `rest`).threads).toEqual([`persona:priya`]);
    });

    it(`threads an identity to the accounts born in its browser, and the cards that carry it`, () => {
        expect(relationsOf(input(), `cap:support-id`).threads).toEqual([`cap:gmail-support`]);
        expect(relationsOf(input(), `cap:gmail-support`).threads).toEqual([`persona:maya`, `cap:support-id`]);
    });

    it(`lights a principal's reach, or a node's holders and ties`, () => {
        const map = buildReachMap(input());
        const sam = lightingOf(map, input(), { kind: `principal`, id: `person:sam@acme.dev` });
        expect(sam.principals.get(`person:sam@acme.dev`)).toBe(`self`);
        expect(sam.nodes.get(`persona:maya`)).toBe(`use`);
        expect(sam.nodes.has(`cap:x-brand`)).toBe(false);
        const maya = lightingOf(map, input(), { kind: `node`, id: `persona:maya` });
        expect(maya.nodes.get(`persona:maya`)).toBe(`self`);
        expect(maya.nodes.get(`cap:gmail-support`)).toBe(`related`);
        expect(maya.principals.get(`person:sam@acme.dev`)).toBe(`use`);
        expect(maya.principals.has(`person:rin@acme.dev`)).toBe(false);
        expect(maya.threads).toEqual([`cap:gmail-support`]);
    });

    // A folded block stands in for its members: it lights whoever reaches any of them, at the strongest way they do.
    it(`lights who reaches anything in a block, at their strongest`, () => {
        const map = buildReachMap(input());
        const services = lightingOf(map, input(), { kind: `node`, id: bundleId(`services`) });
        expect(services.nodes.get(bundleId(`services`))).toBe(`self`);
        expect(services.nodes.get(`cap:github`)).toBe(`related`);
        expect(services.principals.get(`person:jo@acme.dev`)).toBe(`use`);
        expect(services.principals.get(`person:sam@acme.dev`)).toBe(`through`);
        expect(services.principals.has(`person:rin@acme.dev`)).toBe(false);
        const secrets = lightingOf(map, input(), { kind: `node`, id: bundleId(`secrets`) });
        expect([...secrets.nodes.keys()]).toEqual([bundleId(`secrets`), `secret:SENTRY_DSN`, `secret:STRIPE_KEY`]);
    });
});
