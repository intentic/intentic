import { containerNotices, hasContainerFault } from "./containerHealth";

const REACHABILITY_GAP = {
    key: `reachability`,
    missing: [`SANDBOX_GRANT`, `INGRESS_URL`],
    enables: `reaching this sandbox at its public address, from anywhere`,
    lost: `Its public address answers 502 to everyone.`,
    repair: `Re-run this sandbox's setup command.`,
};

const report = (over: Record<string, unknown> = {}) => ({
    reach: `unreachable` as const,
    at: `2026-09-08T10:27:01.000Z`,
    ...over,
});

describe(`containerNotices`, () => {
    it(`says nothing about a healthy sandbox`, () => {
        expect(containerNotices({ bootReport: report({ reach: `reachable` }), announceRefusal: null })).toEqual([]);
        expect(hasContainerFault({ bootReport: report({ reach: `reachable` }), announceRefusal: null })).toBe(false);
    });

    // Never having reported reads as silence, not a healthy claim.
    it(`says nothing when the sandbox has never reported`, () => {
        expect(containerNotices({ bootReport: null, announceRefusal: null })).toEqual([]);
    });

    it(`stays quiet while the daemon is still trying`, () => {
        expect(containerNotices({ bootReport: report({ retrying: true, detail: `its tunnel has not come up.` }), announceRefusal: null })).toEqual(
            [],
        );
        expect(containerNotices({ bootReport: report({ reach: `checking`, retrying: true }), announceRefusal: null })).toEqual([]);
    });

    it(`speaks up once the daemon has stopped trying`, () => {
        const notices = containerNotices({ bootReport: report({ retrying: false, detail: `nothing answered.` }), announceRefusal: null });
        expect(notices).toHaveLength(1);
        expect(notices[0]?.fault).toBe(`unreachable`);
        expect(notices[0]?.detail).toBe(`nothing answered.`);
    });

    // A gap the editor knows gets its own short, translated words; the card's action row is the repair.
    it(`words a known drift gap itself and names the missing keys`, () => {
        const notices = containerNotices({ bootReport: report({ retrying: false, drift: [REACHABILITY_GAP] }), announceRefusal: null });
        expect(notices).toHaveLength(1);
        expect(notices[0]?.fault).toBe(`drift`);
        expect(notices[0]?.keys).toEqual([`SANDBOX_GRANT`, `INGRESS_URL`]);
        expect(notices[0]?.title).toBe(`Unreachable from other devices`);
        expect(notices[0]?.detail).not.toBe(REACHABILITY_GAP.lost);
        expect(notices[0]?.repair).toBeUndefined();
    });

    // A newer daemon's requirement the editor has no words for still says something true: the daemon's own sentence.
    it(`falls back to the daemon's sentence for a drift gap it does not know`, () => {
        const unknown = { ...REACHABILITY_GAP, key: `someday`, lost: `Something it needs is missing.` };
        const notices = containerNotices({ bootReport: report({ retrying: false, drift: [unknown] }), announceRefusal: null });
        expect(notices[0]?.title).toBe(`Its setup is out of date`);
        expect(notices[0]?.detail).toBe(`Something it needs is missing.`);
    });

    // Two copies taking turns at one address are why it stops answering: the copies are the errand, not the silence.
    it(`names the machines running two copies of one sandbox, ahead of the silence they cause`, () => {
        const notices = containerNotices({
            bootReport: report({ retrying: false, detail: `nothing answered.` }),
            announceRefusal: null,
            duplicateCopies: { hosts: [`rog (windows)`, `rog (linux/archlinux)`], since: `2026-10-05T19:00:00.000Z` },
        });
        expect(notices.map((notice) => notice.fault)).toEqual([`duplicate`]);
        expect(notices[0]?.detail).toContain(`rog (windows), rog (linux/archlinux)`);
        expect(containerNotices({ bootReport: null, announceRefusal: null, duplicateCopies: null })).toEqual([]);
    });

    // A container that is both drifted and unreachable reports only drift; unreachable is its symptom.
    it(`reports the cause instead of the symptom it explains`, () => {
        const notices = containerNotices({
            bootReport: report({ retrying: false, detail: `answered 502.`, drift: [REACHABILITY_GAP] }),
            announceRefusal: { announced: `https://a.dev`, expected: `https://b.dev` },
        });
        expect(notices.map((notice) => notice.fault)).toEqual([`drift`]);
    });

    it(`reports a refused check-in when nothing deeper explains it, naming both addresses`, () => {
        const notices = containerNotices({
            bootReport: report({ reach: `reachable` }),
            announceRefusal: { announced: `https://announced.dev`, expected: `https://expected.dev` },
        });
        expect(notices).toHaveLength(1);
        expect(notices[0]?.fault).toBe(`refused`);
        expect(notices[0]?.detail).toContain(`https://announced.dev`);
        expect(notices[0]?.detail).toContain(`https://expected.dev`);
    });

    // Absent retrying means an older daemon, not a settled fault.
    it(`treats a missing retrying flag as still trying`, () => {
        expect(containerNotices({ bootReport: report({ detail: `not up yet.` }), announceRefusal: null })).toEqual([]);
    });
});
