import { describe, expect, it } from "vitest";
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

    it(`names the missing keys and the repair when the container drifted`, () => {
        const notices = containerNotices({ bootReport: report({ retrying: false, drift: [REACHABILITY_GAP] }), announceRefusal: null });
        expect(notices).toHaveLength(1);
        expect(notices[0]?.fault).toBe(`drift`);
        expect(notices[0]?.keys).toEqual([`SANDBOX_GRANT`, `INGRESS_URL`]);
        expect(notices[0]?.repair).toContain(`setup command`);
        // detail is rendered verbatim from the requirements table, not reworded here.
        expect(notices[0]?.detail).toBe(REACHABILITY_GAP.lost);
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
