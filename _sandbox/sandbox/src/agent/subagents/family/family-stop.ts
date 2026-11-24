import type { AgentFamilyStopped } from "@intentic/sandbox-contract/schemas/agents";
import type { Services } from "../../../composition.js";
import { liveRunOf } from "../../../conversations/actor/conversation-holdings.js";
import { cancelFamily, familyOf } from "./child-cancel.js";
import { markFamilyEnded } from "./family-cancel.js";
import { haltConversation } from "../../../conversations/actor/conversation-halt.js";
import { quietHalted } from "./halt-quiet.js";
import { liveRun, stopRunsOf } from "../workflows/live-runs.js";
import { stopScriptRun } from "../workflows/script-runs.js";

// A PERSON'S STOP ALL ON A CARD (agents.stopFamily): the conversation's own turn, the workflow runs it and the agents
// below it started, and every one of those agents' work, stopped together, each staying stopped until somebody writes to
// it (conversations/actor/conversation-halt.ts). A conversation's own Stop ends only its turn,
// and a child stopped by hand only that child: a workflow run starts the next worker as each one stops, and a parent woken
// by a stopped child's ending may start another. Both are what this press ends (2026-11-22: a run on marta kept starting
// workers while its owner stopped them one by one, until the agent was told in words to stop). The card stays on the
// board; the conversations below it keep what they wrote.

/** Stops everything a conversation has going and everything below it; never throws for a part that had already ended. */
export const stopFamily = async (services: Services, conversationId: string): Promise<AgentFamilyStopped> => {
    // Read before the runs stop and again after, so a worker a run started between the two is in the family it stops.
    const before = familyOf(services, [conversationId]);
    const runs = stopRunsOf([conversationId, ...before.members.map(({ child }) => child)], "owner");
    // The endings stopped below are news for nobody: said to it, they would wake it into a turn that may start them again.
    markFamilyEnded(services.conversations, conversationId, Date.now());
    // The card's own conversation stays stopped too (conversations/actor/conversation-halt.ts): nothing it left running wakes it, until the person writes.
    haltConversation(services.conversations, conversationId, "person");
    const turn = liveRunOf(services.conversations, conversationId) === undefined ? false : (await services.turns.stop({ conversationId, live: true })).stopped;
    const cancelled = await cancelFamily(services, familyOf(services, [conversationId]), "stopped");
    await quietHalted(services, conversationId, "person");
    services.logger.info({ conversationId, turn, runs, agents: cancelled.length }, "family stop: a person stopped a conversation and everything it started");
    return { turn, runs, agents: cancelled.length };
};

/** Stops one workflow run of a conversation's as a person's press: its script ends, and its workers at work stop with it. */
export const stopOneRun = (conversationId: string, run: string): AgentFamilyStopped => {
    const live = liveRun(run);
    const working = live?.record.calls.filter((call) => call.state === "running" && call.child !== undefined).length ?? 0;
    return stopScriptRun(conversationId, run, "owner").ok ? { turn: false, runs: 1, agents: working } : { turn: false, runs: 0, agents: 0 };
};
