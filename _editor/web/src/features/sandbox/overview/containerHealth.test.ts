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

    // A sandbox on an image older than the drift check, or one that has never reported. Silence, not a claim.
    it(`says nothing when the sandbox has never reported`, () => {
        expect(containerNotices({ bootReport: null, announceRefusal: null })).toEqual([]);
    });

    /* THE RULE THE WHOLE MODULE EXISTS FOR. A tunnel that is still coming up reports `unreachable` too, and a
     * standing card that fires on it is furniture within a day. */
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
        // Rendered verbatim: the requirements table wrote this sentence for the person who has to act.
        expect(notices[0]?.detail).toBe(REACHABILITY_GAP.lost);
    });

    /* ONE CAUSE, ONE NOTICE. The drifted container is ALSO unreachable — that is the symptom of the very gap
     * above it — and drawing both makes one fault look like two, so the reader fixes the shallower one. */
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

    // An older daemon sends no `retrying` at all. Absent must not read as "settled", or every sandbox mid-setup
    // on a not-yet-updated image grows a permanent fault card.
    it(`treats a missing retrying flag as still trying`, () => {
        expect(containerNotices({ bootReport: report({ detail: `not up yet.` }), announceRefusal: null })).toEqual([]);
    });
});
