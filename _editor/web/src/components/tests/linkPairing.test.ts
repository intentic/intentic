import { timeAgo } from "@intentic/ui/format";
import { type FarSandboxFacts, farSandboxNote, linkCardId, pairableSandboxes, preferredSandbox } from "../linkPairing";

// The sandbox an agent's link ask names, found among the reader's others however the agent spelled it.

const sandboxes = [
    { id: `7e8d0ffa8bed`, name: `Ops box`, daemonUrl: `https://sandbox-7e8d0ffa8bed.radarsu.com` },
    { id: `da29324afede`, name: `client`, daemonUrl: `https://sandbox-da29324afede.radarsu.com` },
    { id: `ca724a4618f7`, name: `Client`, daemonUrl: null },
];

describe(`preferredSandbox`, () => {
    it(`finds one by its name, its card id, its id or its address`, () => {
        expect(preferredSandbox(sandboxes, `Ops box`)?.id).toBe(`7e8d0ffa8bed`);
        expect(preferredSandbox(sandboxes, linkCardId(`Ops box`))?.id).toBe(`7e8d0ffa8bed`);
        expect(preferredSandbox(sandboxes, `7E8D0FFA8BED`)?.id).toBe(`7e8d0ffa8bed`);
        expect(preferredSandbox(sandboxes, `https://sandbox-da29324afede.radarsu.com/`)?.id).toBe(`da29324afede`);
        expect(preferredSandbox(sandboxes, `sandbox-da29324afede.radarsu.com`)?.id).toBe(`da29324afede`);
    });

    it(`chooses nothing when nothing, or more than one, answers to it`, () => {
        expect(preferredSandbox(sandboxes, undefined)).toBeUndefined();
        expect(preferredSandbox(sandboxes, ` `)).toBeUndefined();
        expect(preferredSandbox(sandboxes, `staging`)).toBeUndefined();
        expect(preferredSandbox(sandboxes, `client`)).toBeUndefined();
    });
});

// What the picker says beside each of the reader's other sandboxes, read off the platform's row: where it runs, and
// whether it answers now.
describe(`farSandboxNote`, () => {
    const NOW = Date.parse(`2026-11-11T12:00:00Z`);
    const own = (over: Partial<FarSandboxFacts>): FarSandboxFacts => ({ hosted: null, hostReport: null, sleep: null, lastSeenAt: null, ...over });
    const report: NonNullable<FarSandboxFacts[`hostReport`]> = { source: `agent`, machine: `rog`, os: `windows`, stage: `done`, checks: [], at: `2026-11-11T11:00:00Z` };

    it(`names the machine and when it last checked in`, () => {
        const heard = `2026-11-11T11:55:00Z`;
        expect(farSandboxNote(own({ hostReport: report, lastSeenAt: heard }), NOW)).toBe(`rog · last heard ${timeAgo(Date.parse(heard), { now: NOW, days: true })}`);
    });

    it(`says a sleeping one sleeps, and when its machine cannot wake it`, () => {
        expect(farSandboxNote(own({ hostReport: report, sleep: { heardAt: `2026-11-11T11:59:00Z`, wakeable: true } }), NOW)).toBe(`rog · asleep`);
        expect(farSandboxNote(own({ sleep: { heardAt: `2026-11-10T11:59:00Z`, wakeable: false } }), NOW)).toBe(`asleep, its machine is off`);
    });

    it(`says a hosted one is in the cloud, in its own state's words, and nothing for a state it cannot read`, () => {
        expect(farSandboxNote(own({ hosted: { state: `asleep`, region: `fra`, warm: true } }), NOW)).toBe(`Intentic cloud · asleep`);
        expect(farSandboxNote(own({ hosted: { state: `unknown`, region: `fra`, warm: true } }), NOW)).toBe(`Intentic cloud`);
    });
});

// Offered only where the reader may mint a link: the far side's Linked sandboxes are a maintainer's, as its own page is.
describe(`pairableSandboxes`, () => {
    it(`keeps the reader's others they own or maintain, with an address, and never this one`, () => {
        const rows = [
            { id: `here`, role: `owner`, daemonUrl: `https://here.test` },
            { id: `mine`, role: `owner`, daemonUrl: `https://mine.test` },
            { id: `ops`, role: `maintainer`, daemonUrl: `https://ops.test` },
            { id: `shared`, role: `collaborator`, daemonUrl: `https://shared.test` },
            { id: `unfinished`, role: `owner`, daemonUrl: null },
        ];
        expect(pairableSandboxes(rows, `here`).map((row) => row.id)).toEqual([`mine`, `ops`]);
    });
});
