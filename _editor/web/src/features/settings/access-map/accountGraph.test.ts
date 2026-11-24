import type { SandboxReach } from "@intentic/sandbox-contract/schemas/sandbox-reach";
import { buildAccountGraph, CLOUD_ID, lightingOf, type PlatformSandbox, type ReachRead, sandboxNodeId, YOU_ID } from "./accountGraph";

// One account's sandboxes, each answering as its daemon would: two of its own (one on its owner's PC, one in the cloud,
// the first handing work to the second and both reaching the same PC), one shared with it that is too old to answer,
// one whose daemon says the reader's tier was narrowed after the platform last heard, and a sandbox outside the account
// that hands work to one of its own.

const READ_AT = 1_800_000_000_000;
const PC = `m-rog-00000001`;

const row = (id: string, tier: PlatformSandbox[`tier`], extra: Partial<PlatformSandbox> = {}): PlatformSandbox => ({
    id,
    name: id,
    image: null,
    tier,
    daemonUrl: `https://sandbox-${id}.sbx.intentic.dev`,
    hosted: null,
    ...extra,
});

const answer = (extra: Partial<SandboxReach> = {}): SandboxReach => ({
    self: {},
    reader: { tier: `owner`, agents: true },
    linksOut: [],
    devices: [],
    servers: [],
    readAt: READ_AT,
    ...extra,
});

const alpha = answer({
    self: { sandboxId: `alpha`, runsOn: { host: `ROG`, os: `windows` } },
    linksOut: [
        {
            card: `beta`,
            name: `beta`,
            sandboxId: `beta`,
            host: `sandbox-beta.sbx.intentic.dev`,
            answer: `answering`,
            terms: { tasks: true, records: false, operate: true, approve: false },
            yours: true,
            others: 2,
        },
    ],
    devices: [{ card: `rog`, kind: `computer`, label: `rog`, machineId: PC, platform: `windows`, online: true, grants: [`screen`, `shell`], yours: true, others: 1 }],
    servers: [{ card: `deploy`, host: `10.0.0.5`, user: `deploy`, admin: true, yours: true, others: 0 }],
    fleet: { yours: true, others: 1 },
    people: 2,
});

const beta = answer({
    self: { sandboxId: `beta`, org: { id: `org-1`, name: `Acme` } },
    linksIn: [
        {
            id: `ilk-1`,
            label: `alpha`,
            sandboxId: `alpha`,
            terms: { tasks: true, records: false, operate: true, approve: false, role: `Ops`, runAs: `Night fixer` },
            waiting: 0,
        },
        {
            id: `ilk-2`,
            label: `agency`,
            host: `sandbox-zzz.sbx.intentic.dev`,
            terms: { tasks: true, records: true, operate: false, approve: true },
            waiting: 1,
        },
    ],
    devices: [{ card: `my-pc`, kind: `computer`, label: `My PC`, machineId: PC, online: false, grants: [`screen`], yours: true }],
});

const delta = answer({ reader: { tier: `viewer`, agents: false } });

const reads = new Map<string, ReachRead>([
    [`alpha`, { state: `fresh`, answer: alpha }],
    [`beta`, { state: `asleep`, answer: beta }],
    [`gamma`, { state: `old` }],
    [`delta`, { state: `fresh`, answer: delta }],
]);

const graph = buildAccountGraph({
    email: `me@example.com`,
    orgs: [{ id: `org-1`, name: `Acme`, role: `member` }],
    sandboxes: [
        row(`alpha`, `owner`, { hostReport: { machine: `rog` } }),
        row(`beta`, `owner`, { hosted: { state: `asleep`, region: `fra`, warm: true } }),
        row(`gamma`, `collaborator`),
        row(`delta`, `maintainer`),
    ],
    reads,
    claims: new Map([[`beta`, [`github.com/acme/app`, `github.com/acme/billing`]]]),
});

const edge = (id: string) => graph.edges.find((candidate) => candidate.id === id);

describe(`buildAccountGraph`, () => {
    // The platform's directory, the one tie no daemon describes: which sandbox the reader's other sandboxes report to.
    test(`marks the sandboxes that answer for projects, and only those`, () => {
        const node = (id: string) => graph.sandboxes.find((sandbox) => sandbox.id === sandboxNodeId(id));
        expect(node(`beta`)?.projects).toEqual([`github.com/acme/app`, `github.com/acme/billing`]);
        expect(node(`alpha`)?.projects).toBeUndefined();
    });

    test(`stands the account's own sandboxes first, then those shared with it, then those met only through a link`, () => {
        expect(graph.sandboxes.map((sandbox) => [sandbox.id, sandbox.standing])).toEqual([
            [sandboxNodeId(`alpha`), `yours`],
            [sandboxNodeId(`beta`), `yours`],
            [sandboxNodeId(`gamma`), `shared`],
            [sandboxNodeId(`delta`), `shared`],
            [`beyond:sandbox-zzz.sbx.intentic.dev`, `beyond`],
        ]);
    });

    test(`keeps a sandbox's last answer, marked by how its read stands now`, () => {
        expect(graph.nodes.get(sandboxNodeId(`beta`))).toMatchObject({ read: `asleep`, readAt: READ_AT, org: { id: `org-1`, name: `Acme` }, cloud: true });
        expect(graph.nodes.get(sandboxNodeId(`gamma`))).toMatchObject({ read: `old`, readAt: undefined, tier: `collaborator` });
    });

    test(`takes the daemon's word for the reader's tier, keeping the platform's beside it when they disagree`, () => {
        expect(graph.nodes.get(sandboxNodeId(`delta`))).toMatchObject({ tier: `viewer`, platformTier: `maintainer`, agents: false });
        expect(edge(`member:${sandboxNodeId(`delta`)}`)).toMatchObject({ tier: `viewer`, acting: false });
        expect(graph.nodes.get(sandboxNodeId(`alpha`))).toMatchObject({ tier: `owner`, platformTier: undefined });
    });

    test(`draws one computer for one machine id, however many sandboxes reach it and whatever each calls it`, () => {
        const computers = graph.machines.filter((machine) => machine.kind === `computer`);
        expect(computers).toEqual([{ id: `machine:${PC}`, kind: `computer`, label: `rog`, platform: `windows`, online: true, detail: undefined }]);
        expect(graph.edges.filter((candidate) => candidate.to === `machine:${PC}`).map((candidate) => candidate.id)).toEqual([
            `device:${sandboxNodeId(`alpha`)}>machine:${PC}:rog`,
            `device:${sandboxNodeId(`beta`)}>machine:${PC}:my-pc`,
            `runs:${sandboxNodeId(`alpha`)}`,
        ]);
    });

    test(`joins where a sandbox runs to the computer of that name, and a hosted one to the cloud`, () => {
        expect(edge(`runs:${sandboxNodeId(`alpha`)}`)).toMatchObject({ to: `machine:${PC}` });
        expect(edge(`runs:${sandboxNodeId(`beta`)}`)).toMatchObject({ to: CLOUD_ID });
    });

    test(`makes one link of a tie seen from both ends: the asking side's driving, the taking side's terms`, () => {
        expect(edge(`link:${sandboxNodeId(`alpha`)}>${sandboxNodeId(`beta`)}`)).toEqual({
            id: `link:${sandboxNodeId(`alpha`)}>${sandboxNodeId(`beta`)}`,
            kind: `link`,
            from: sandboxNodeId(`alpha`),
            to: sandboxNodeId(`beta`),
            card: `beta`,
            answer: `answering`,
            terms: { tasks: true, records: false, operate: true, approve: false, role: `Ops`, runAs: `Night fixer` },
            yours: true,
            acting: true,
            others: 2,
        });
    });

    test(`orders what deserves reading first: the account itself, a sandbox from outside, a machine, then a sandbox`, () => {
        expect(graph.exposures.map((exposure) => [exposure.kind, exposure.from, exposure.to, exposure.others])).toEqual([
            [`fleet`, sandboxNodeId(`alpha`), YOU_ID, 1],
            [`inbound`, `beyond:sandbox-zzz.sbx.intentic.dev`, sandboxNodeId(`beta`), undefined],
            [`machine`, sandboxNodeId(`alpha`), `machine:${PC}`, 1],
            [`operate`, sandboxNodeId(`alpha`), sandboxNodeId(`beta`), 2],
        ]);
    });

    test(`counts no exposure where nobody else can use the tie, or where it only looks`, () => {
        expect(graph.exposures.some((exposure) => exposure.kind === `server`)).toBe(false);
        expect(graph.exposures.some((exposure) => exposure.edge.includes(`my-pc`))).toBe(false);
    });
});

describe(`lightingOf`, () => {
    test(`from the reader: every sandbox they are in and what their own agents can drive from there`, () => {
        const lit = lightingOf(graph, YOU_ID);
        expect([...lit.nodes].sort()).toEqual(
            [YOU_ID, sandboxNodeId(`alpha`), sandboxNodeId(`beta`), sandboxNodeId(`gamma`), sandboxNodeId(`delta`), `machine:${PC}`, `server:10.0.0.5`].sort(),
        );
        // A sandbox outside the account reaches in; the reader does not reach out through it.
        expect(lit.nodes.has(`beyond:sandbox-zzz.sbx.intentic.dev`)).toBe(false);
    });

    test(`from a computer: every sandbox that reaches it or runs on it, and the reader's way into each`, () => {
        const lit = lightingOf(graph, `machine:${PC}`);
        expect([...lit.nodes].sort()).toEqual([YOU_ID, sandboxNodeId(`alpha`), sandboxNodeId(`beta`), `machine:${PC}`].sort());
        expect(lit.edges.has(`member:${sandboxNodeId(`alpha`)}`)).toBe(true);
        expect(lit.edges.has(`member:${sandboxNodeId(`gamma`)}`)).toBe(false);
    });

    test(`from a sandbox: its ties either way round, without the reader's ways into its neighbours`, () => {
        const lit = lightingOf(graph, sandboxNodeId(`beta`));
        expect([...lit.nodes].sort()).toEqual(
            [YOU_ID, sandboxNodeId(`alpha`), sandboxNodeId(`beta`), `beyond:sandbox-zzz.sbx.intentic.dev`, `machine:${PC}`, CLOUD_ID].sort(),
        );
        expect(lit.edges.has(`member:${sandboxNodeId(`alpha`)}`)).toBe(false);
    });
});
