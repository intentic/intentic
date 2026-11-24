import type { AgentJob, AgentWatch } from "@intentic/sandbox-contract/schemas/agents";
import { idleConversation } from "../../actor/conversation-state.js";
import type { PersistedAgent } from "../agents-store.js";
import { conversationEntry } from "../agents-store.testing.js";
import { describedBy, liveReadings } from "./agent-summary.js";

// SAFETY: liveReadings reads only `unfinished` off the entry, which this one leaves absent.
const entry = {} as PersistedAgent;
const job = (id: string): AgentJob => ({ id, label: id, session: `job-${id}`, startedAt: 1 });
const watch: AgentWatch = { id: "watch-1", note: "CI", intervalSeconds: 60, deadlineAt: 2 };

describe("a card's jobs and watches", () => {
    test("list a runner conversation's, held by its runner, after this sandbox's own", () => {
        const readings = liveReadings(entry, { ...idleConversation(), jobs: [job("here")], runnerJobs: [job("there")], runnerWatches: [watch] });
        expect(readings.jobs?.map((one) => one.id)).toEqual(["here", "there"]);
        expect(readings.watches).toEqual([watch]);
    });

    test("stay absent when neither holds any", () => {
        const readings = liveReadings(entry, idleConversation());
        expect(readings.jobs).toBeUndefined();
        expect(readings.watches).toBeUndefined();
    });
});

describe("a card's projection is memoized", () => {
    test("the live readings are projected once per actor state and entry, and again for a new one of either", () => {
        const state = { ...idleConversation(), jobs: [job("here")] };
        const first = liveReadings(entry, state);
        expect(liveReadings(entry, state)).toBe(first);
        // An event replaces the state whole, which is the change signal the memo goes by.
        const next = { ...state, jobs: [job("here"), job("also")] };
        expect(liveReadings(entry, next).jobs?.map((one) => one.id)).toEqual(["here", "also"]);
        // SAFETY: as `entry`, plus the one field liveReadings reads off it.
        const unfinished = { unfinished: { steps: { total: 3, open: 1 } } } as PersistedAgent;
        expect(liveReadings(unfinished, state).checklist).toEqual({ done: 2, total: 3 });
    });

    test("what an entry says is projected once per entry object", () => {
        const described = conversationEntry();
        const first = describedBy(described);
        expect(describedBy(described)).toBe(first);
        const renamed = conversationEntry({ profile: { ...described.profile, model: "another" } });
        expect(describedBy(renamed)).not.toBe(first);
        expect(describedBy(renamed).model).toBe("another");
    });
});
