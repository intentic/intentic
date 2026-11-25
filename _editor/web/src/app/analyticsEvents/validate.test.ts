import { ANALYTICS_EVENTS } from "./eventRegistry";
import { BURST_LIMIT, BURST_WINDOW_MS, createBurstCap, validEvent } from "./validate";

// What `track` lets through: a registered name with exactly its schema's properties, and nothing that could carry a
// path, a branch or a sentence where a code belongs.

// SAFETY: a shape no call site could compile, which is exactly what the runtime check is for.
const wrong = (properties: Record<string, string | number>): never => properties as never;

const quietly = <T>(run: () => T): T => {
    const warn = jest.spyOn(console, `warn`).mockImplementation(() => undefined);
    try {
        return run();
    } finally {
        warn.mockRestore();
    }
};

describe(`validEvent`, () => {
    it(`passes a registered event with the properties its schema names`, () => {
        expect(validEvent(`message_sent`, { agent: `claude`, queued: false })).toEqual({ agent: `claude`, queued: false });
        expect(validEvent(`voice_wake_on`, {})).toEqual({});
        expect(validEvent(`voice_wake_on`, undefined)).toEqual({});
    });

    it(`drops a name the registry does not list, and says so in a development build`, () => {
        const warn = jest.spyOn(console, `warn`).mockImplementation(() => undefined);
        expect(validEvent(`made_up_event`, {})).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`dropped "made_up_event"`));
        warn.mockRestore();
    });

    it(`does not take a name off Object's prototype for an event`, () => {
        expect(quietly(() => validEvent(`toString`, {}))).toBeUndefined();
    });

    it(`drops an unknown key, a missing key and a value outside its enum`, () => {
        quietly(() => {
            expect(validEvent(`message_sent`, wrong({ agent: `claude`, branch: `main` }))).toBeUndefined();
            expect(validEvent(`message_edited`, {})).toBeUndefined();
            expect(validEvent(`sandbox_wake`, wrong({ source: `elsewhere`, outcome: `success` }))).toBeUndefined();
            expect(validEvent(`git_op_slow`, wrong({ op: `commit`, files: `3`, ms: 9000 }))).toBeUndefined();
        });
    });

    it(`drops a code that reads as a path, a sentence or an over-long string`, () => {
        quietly(() => {
            expect(validEvent(`turn_failed`, { code: `src/secret/plan.ts`, repeats: 1 })).toBeUndefined();
            expect(validEvent(`turn_failed`, { code: `could not reach the host`, repeats: 1 })).toBeUndefined();
            expect(validEvent(`turn_failed`, { code: `x`.repeat(65), repeats: 1 })).toBeUndefined();
            expect(validEvent(`sandbox_setup_failed`, { stage: `docker`, checks: `disk`, problem: `y`.repeat(601) })).toBeUndefined();
        });
        expect(validEvent(`turn_failed`, { code: `agent-domain-refused`, repeats: 2 })).toEqual({ code: `agent-domain-refused`, repeats: 2 });
    });

    it(`keeps the milestones' own person properties`, () => {
        const at = new Date(0).toISOString();
        expect(validEvent(`signed_up`, { method: `google`, $set_once: { signed_up_at: at } })).toEqual({ method: `google`, $set_once: { signed_up_at: at } });
    });

    it(`holds every registered schema to a closed object, so no event takes keys nobody listed`, () => {
        for (const [name, schema] of Object.entries(ANALYTICS_EVENTS)) {
            expect([name, schema.safeParse({ __unlisted: 1 }).success]).toEqual([name, false]);
        }
    });
});

describe(`createBurstCap`, () => {
    it(`lets BURST_LIMIT of one event through a window, refuses the next, and frees up as the window moves on`, () => {
        let now = 0;
        const allow = quietly(() => createBurstCap(() => now));
        const first = Array.from({ length: BURST_LIMIT }, () => allow(`voice_phrase`));
        expect(first.every(Boolean)).toBe(true);
        expect(quietly(() => allow(`voice_phrase`))).toBe(false);
        // Another event's count is its own.
        expect(allow(`voice_failed`)).toBe(true);
        now = BURST_WINDOW_MS;
        expect(allow(`voice_phrase`)).toBe(true);
    });
});
