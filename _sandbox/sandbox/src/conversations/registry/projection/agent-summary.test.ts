import type { AgentJob, AgentWatch } from "@intentic/sandbox-contract/schemas/agents";
import { idleConversation } from "../../actor/conversation-state.js";
import type { PersistedAgent } from "../agents-store.js";
import { liveReadings } from "./agent-summary.js";

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
