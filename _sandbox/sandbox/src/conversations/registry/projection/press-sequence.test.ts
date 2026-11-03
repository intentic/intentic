import { IN_MEMORY } from "@intentic/base/sqlite";
import { unstubbed } from "@intentic/testing";
import { pino } from "pino";
import { AgentErrorCodeSchema } from "@intentic/sandbox-contract/events/agent-events";
import { failureCourseOf } from "@intentic/sandbox-contract/policy/failure-codes";
import type { ResumeReason } from "@intentic/sandbox-contract/events/resume";
import type { AgentPress } from "@intentic/sandbox-contract/schemas/agent-press";
import type { AgentStatus } from "@intentic/sandbox-contract/schemas/agents";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import type { HeldEnding, TurnBreakPolicy } from "@intentic/sandbox-contract/schemas/turn-break";
import type { Services } from "../../../composition.js";
import { classifyFailure, type FailureContext, type FailureQueries } from "../../../agent/run/frames/classify-failure.js";
import { carryOnTurn, createTurnResumeScheduler } from "../../../agent/run/turn/turn-resume.js";
import type { TurnInput } from "../../../seams/turn-starter.js";
import { openConversationsDb } from "../../../store/conversations-db.js";
import { beginTurn } from "../../actor/conversation-actors.testing.js";
import { restoreLimitHolds } from "../../actor/limit-hold.js";
import { noPresences } from "../../land/tests/landed-presence.testing.js";
import { createFleet, type Fleet } from "../agents-registry.js";
import { fleetStoreOver, memoryFleet } from "../agents-registry.testing.js";
import { conversationEntry } from "../agents-store.testing.js";
import { endingOf } from "./turn-ending.js";

/* THE CARD'S PRESS THROUGH A TURN'S WHOLE LIFE, AS THE DAEMON LIVES IT: a failure classified as the stream classifies it
   (classify-failure.ts), its hold taken and the turn settled as the settlement does, then the press a person makes (the
   route's carryOnTurn) or the re-run the sandbox makes by itself, the new turn begun, and that turn settled. After every
   step the card's `press` is read and held against what the step leaves: a chat's strip follows it, so a step that left
   it saying anything else is a strip offering a press nothing would act on, or none where one would. */

const PROFILE = { agent: "claude", harness: "native" } as const;
const NOW = Date.now();
const RESET = Math.ceil(NOW / 1000) + 3_600;
const standing = { state: "no-code", paths: [], check: undefined } as const;

// A turn on conversation `id` as it stood when its failure arrived, with each wall's own fact the code calls for: the
// breaker's state for an outage (recorded only for one, stream-agent.ts), a credential to re-mint for a refused token,
// the stream's reset for a spent allowance.
const contextOn = (id: string, now: number, code?: string): FailureContext => ({
    turn: { ...PROFILE, prompt: "Fix the parser", conversationId: id },
    turnId: `t-${id}`,
    provider: "claude",
    model: "opus",
    account: "acct",
    attribution: { account: "acct" },
    sessionId: "s-1",
    answered: true,
    remint: { account: "acct", refusedToken: "tok-1" },
    limitReset: RESET,
    outage: code === "provider-outage" ? { attempt: 0, retryAt: now + 30_000 } : undefined,
    standing,
    checklist: undefined,
    contextTokens: 9_000,
    now,
});

// The conversation's answer to every wall, as the classification asks it: armed (`retry`, a limit's `resend`) or not.
const answering = (armed: boolean): FailureQueries => ({
    breakPolicy: async (_id, ending): Promise<TurnBreakPolicy> => (!armed ? "wait" : ending === "limit" || ending === "memory" ? "resend" : "retry"),
    reopensAt: async () => undefined,
    standingReopensAt: async () => undefined,
    limitWay: async () => ({ standing, contextTokens: 9_000, handoffTokens: 1_200 }),
    stopLadder: () => ({ made: 0, nextAt: NOW + 5_000 }),
    awaitingVerification: async () => [],
});

// A fleet whose person's presses and sandbox's re-runs start real turns on the actor, as the run's start does: the begin,
// then the hold it takes the place of let go (stream-agent.ts). What each start was asked is kept.
const pressingFleet = async (fleet: Fleet = memoryFleet()) => {
    await fleet.agents.init();
    const started: TurnInput[] = [];
    const turns = unstubbed<Services["turns"]>("turns", {
        start: async (turn) => {
            const conversationId = turn.conversationId ?? "";
            const outcome = await beginTurn(fleet.conversations, { conversationId, isolated: true, prompt: turn.prompt, profile: PROFILE }, Date.now());
            if (outcome !== "begun") {
                return outcome;
            }
            await fleet.conversations.send(conversationId, { kind: "resume-superseded" }).settled;
            started.push(turn);
            return { id: `run-${started.length}`, async *frames() {} };
        },
    });
    return { ...fleet, turns, started };
};

type PressingFleet = Awaited<ReturnType<typeof pressingFleet>>;

// What one read of the card says: its status, and its press.
interface CardRead {
    readonly status: AgentStatus | undefined;
    readonly press: AgentPress | undefined;
}

// The card and the record, read together: the record's `ending` is the card's press, and the card always says one.
const read = (fleet: PressingFleet, id: string): CardRead => {
    const card = fleet.agents.get(id);
    const press = card?.press;
    expect([id, endingOf(fleet, id)]).toEqual([id, press?.kind === "continue" ? press.ending : undefined]);
    return { status: card?.status, press };
};

const reasonOf = (press: AgentPress | undefined): HeldEnding | "none" | undefined =>
    press === undefined ? undefined : press.kind === "none" ? "none" : press.ending.reason;

// A person's Continue, as the route makes it.
const pressContinue = async (fleet: PressingFleet, id: string) =>
    carryOnTurn({ agents: fleet.agents, conversations: fleet.conversations, turns: fleet.turns }, { ...PROFILE, conversationId: id, prompt: "" });

// The new turn runs to its own end: it got somewhere, and settles with nothing to carry on.
const settleClean = async (fleet: PressingFleet, id: string): Promise<void> => {
    fleet.conversations.send(id, { kind: "turn-got-somewhere" });
    await fleet.conversations.send(id, { kind: "settle" }).settled;
};

// What each course leaves the card once its turn settled, armed or not: its status and the reason its press carries on
// from ("none" for nothing), and whether only a press sends it.
interface Left {
    readonly status: AgentStatus;
    readonly reason: HeldEnding | "none";
    readonly pressOnly?: true;
    // The note a person's press re-runs it with: a held turn's own wall, or the session carried on ("continued").
    readonly resume?: ResumeReason;
}

const leftBy = (code: string | undefined, armed: boolean): Left => {
    switch (failureCourseOf(code)) {
        case "limit":
            return { status: "error", reason: "limit", resume: "limit" };
        // Armed, the breaker brings it back by itself: work in progress, nothing to press.
        case "outage":
            return armed ? { status: "resuming", reason: "none" } : { status: "error", reason: "outage", resume: "outage" };
        // Re-minted, or re-run in a fresh session, at once, on no answer.
        case "remint":
        case "overflow":
            return { status: "resuming", reason: "none" };
        case "flagged":
            return { status: "error", reason: "flagged", resume: "flagged" };
        case "carry":
            if (code === undefined) {
                return armed ? { status: "resuming", reason: "none" } : { status: "error", reason: "stopped", resume: "stopped" };
            }
            return { status: "error", reason: "stopped", pressOnly: true, resume: "stopped" };
        case "door":
        case "bare":
        case "note":
            return { status: "error", reason: "none" };
    }
};

const CODES = [undefined, ...AgentErrorCodeSchema.options].flatMap((code) => [
    [code ?? "uncoded", code, false] as const,
    [code ?? "uncoded", code, true] as const,
]);

describe("the card's press through a failure, its hold, the press or re-run, and the turn after", () => {
    test.each(CODES)("%s, armed %p, says at each step what that step leaves", async (_name, code, armed) => {
        const fleet = await pressingFleet();
        const id = `c-${code ?? "uncoded"}-${armed}`;
        await beginTurn(fleet.conversations, { conversationId: id, isolated: true, prompt: "Fix the parser", profile: PROFILE }, NOW - 60_000);
        expect(read(fleet, id)).toEqual({ status: "running", press: { kind: "none" } });

        // The failure, classified and held as the stream does, then the settle.
        const plan = await classifyFailure({ kind: "error", code, message: "It stopped." }, contextOn(id, NOW - 30_000, code), answering(armed));
        fleet.conversations.send(id, { kind: "frame", frame: plan.frame });
        // Still running until the settle: nothing to press over a turn not yet over.
        expect(reasonOf(read(fleet, id).press)).toBe("none");
        if (plan.held !== undefined) {
            fleet.conversations.send(id, { kind: "turn-held", held: plan.held });
        }
        await fleet.conversations.send(id, { kind: "settle" }).settled;

        const left = leftBy(code, armed);
        const settled = read(fleet, id);
        expect([settled.status, reasonOf(settled.press)]).toEqual([left.status, left.reason]);
        const held = settled.press?.kind === "continue" ? settled.press.ending.held : undefined;
        // Only a turn at its own ceiling is held for a press alone, said so on the press, and never booked or laddered.
        expect(held?.pressOnly).toBe(left.pressOnly);
        if (left.pressOnly === true) {
            expect(settled.press).not.toMatchObject({ ending: { retries: expect.anything() } });
            expect(fleet.agents.get(id)?.next).toBeUndefined();
        }

        if (left.reason === "none") {
            // Nothing to press: the next thing is a turn of its own (the sandbox's re-run, or a person's words), which ends
            // the hold and reads none until it settles, and none after.
            await fleet.turns.start({ ...PROFILE, conversationId: id, prompt: "next" });
        } else {
            // The person's press: the held turn re-runs on its own wall's note, or the session is carried on.
            expect(await pressContinue(fleet, id)).toMatchObject({ id: expect.any(String) });
            expect(fleet.started.at(-1)?.resume).toBe(left.resume);
        }
        expect(read(fleet, id)).toEqual({ status: "running", press: { kind: "none" } });
        expect(fleet.conversations.state(id)?.resume.held).toBeUndefined();

        await settleClean(fleet, id);
        expect(read(fleet, id)).toEqual({ status: "idle", press: { kind: "none" } });
    });
});

/* A STOP AND A RESTART. A person's Stop leaves nothing held: the press carries the session on in its own words, which are
   none of the person's. A daemon killed under the turn reads `interrupted`, the same. */
describe("the card's press after a Stop and after a restart", () => {
    test("a Stop reads none while it unwinds, Continue once stopped, and none again once the press runs", async () => {
        const fleet = await pressingFleet();
        await beginTurn(fleet.conversations, { conversationId: "c1", isolated: true, prompt: "Fix the parser", profile: PROFILE }, NOW);
        fleet.conversations.send("c1", { kind: "stop", ending: "stopped" });
        expect(read(fleet, "c1")).toEqual({ status: "stopping", press: { kind: "none" } });
        await fleet.conversations.send("c1", { kind: "settle" }).settled;
        expect(read(fleet, "c1")).toEqual({ status: "stopped", press: { kind: "continue", ending: { reason: "stopped" } } });

        await pressContinue(fleet, "c1");
        expect(fleet.started.at(-1)?.resume).toBe("continued");
        expect(read(fleet, "c1")).toEqual({ status: "running", press: { kind: "none" } });
        await settleClean(fleet, "c1");
        expect(read(fleet, "c1")).toEqual({ status: "idle", press: { kind: "none" } });
    });

    test("a turn a restart killed offers Continue, which carries the session on", async () => {
        const store = fleetStoreOver(openConversationsDb(IN_MEMORY));
        store.agents.save([conversationEntry({ id: "c1", ending: { kind: "interrupted" }, createdAt: 1_000, updatedAt: 1_000 })]);
        const fleet = await pressingFleet(memoryFleet(store));
        expect(read(fleet, "c1")).toEqual({ status: "interrupted", press: { kind: "continue", ending: { reason: "stopped" } } });
        await pressContinue(fleet, "c1");
        expect(fleet.started.at(-1)?.resume).toBe("continued");
        expect(read(fleet, "c1").press).toEqual({ kind: "none" });
    });
});

/* A LAND BESIDE A HELD ENDING. A land runs beside the turn's ending, never instead of it: through its lease, after it, and
   after one that broke, the press is what the turn left. */
describe("the card's press beside a land", () => {
    test("stays what a turn at its own ceiling left, through the land, after it, and after one that broke", async () => {
        const fleet = await pressingFleet();
        await beginTurn(fleet.conversations, { conversationId: "c1", isolated: true, prompt: "Fix the parser", profile: PROFILE }, NOW);
        const plan = await classifyFailure({ kind: "error", code: "turn-cap", message: "Reached the maximum number of turns." }, contextOn("c1", NOW), answering(true));
        fleet.conversations.send("c1", { kind: "frame", frame: plan.frame });
        if (plan.held !== undefined) {
            fleet.conversations.send("c1", { kind: "turn-held", held: plan.held });
        }
        await fleet.conversations.send("c1", { kind: "settle" }).settled;
        const left = read(fleet, "c1").press;
        expect(left).toEqual({ kind: "continue", ending: { reason: "stopped", held: { ran: true, contextTokens: 9_000, pressOnly: true } } });

        fleet.conversations.send("c1", { kind: "land-leased" });
        expect(read(fleet, "c1")).toEqual({ status: "landing", press: left });
        await fleet.agents.recordLandFailure("c1", { reason: "the merge broke" });
        expect(read(fleet, "c1")).toEqual({ status: "landing", press: left });
        fleet.conversations.send("c1", { kind: "land-released" });
        expect(read(fleet, "c1")).toEqual({ status: "error", press: left });
        expect(fleet.agents.get("c1")?.landFailure).toMatchObject({ reason: "the merge broke" });

        // The press still re-runs the held turn, not a new message.
        await pressContinue(fleet, "c1");
        expect(fleet.started.at(-1)).toMatchObject({ resume: "stopped", sessionId: "s-1" });
    });
});

/* A DOOR'S HOLD. A turn the sandbox started and the door turned away (turn-resume.ts holdTurnedAway) is held whole, but
   its card offers no press: whether it goes past that wall is the person's call, made by their words or the room the
   memory wall waits for (`next`), never by a strip's Continue that would only meet the same door. */
describe("the card's press over a door's hold", () => {
    test.each(AgentErrorCodeSchema.options.filter((code) => failureCourseOf(code) === "door"))("%s offers none, and its next turn ends the hold", async (code) => {
        const fleet = await pressingFleet();
        await beginTurn(fleet.conversations, { conversationId: "c1", isolated: true, prompt: "Fix the parser", profile: PROFILE }, NOW);
        fleet.conversations.send("c1", { kind: "frame", frame: { kind: "error", code, message: "Turned away." } });
        fleet.conversations.send("c1", { kind: "turn-held", held: { input: { conversationId: "c1", prompt: "Fix the parser", ...PROFILE }, reason: "door", ran: false, run: "run-0" } });
        await fleet.conversations.send("c1", { kind: "settle" }).settled;
        expect(read(fleet, "c1")).toEqual({ status: "error", press: { kind: "none" } });
        await fleet.turns.start({ ...PROFILE, conversationId: "c1", prompt: "try again" });
        expect(read(fleet, "c1")).toEqual({ status: "running", press: { kind: "none" } });
        expect(fleet.conversations.state("c1")?.resume.held).toBeUndefined();
    });
});

/* A TURN AT ITS OWN CEILING ACROSS A RESTART. Kept on its entry as held for a press alone and put back as one, it is never
   sent by the resume pass however long it waits, whatever the conversation's answer to a stop, its card still offers
   Continue saying so (no rungs, no booking), and the press re-runs the very turn on its session. */
describe("a turn held for a press alone, across a restart", () => {
    const silent = pino({ level: "silent" });

    test("is never fired by the pass, still offers Continue, and the press re-runs it", async () => {
        const store = fleetStoreOver(openConversationsDb(IN_MEMORY));
        const before = memoryFleet(store);
        await before.agents.init();
        // An earlier ordinary stop climbed a rung, which the count the hold carries remembers.
        await beginTurn(before.conversations, { conversationId: "c1", isolated: true, prompt: "Fix the parser", profile: PROFILE }, NOW - 120_000);
        const plan = await classifyFailure({ kind: "error", code: "harness-incomplete", message: "Ended incomplete." }, contextOn("c1", NOW - 120_000), answering(true));
        before.conversations.send("c1", { kind: "frame", frame: plan.frame });
        if (plan.held === undefined) {
            throw new Error("expected a hold");
        }
        before.conversations.send("c1", { kind: "turn-held", held: plan.held }, NOW - 120_000);
        await before.conversations.send("c1", { kind: "settle" }, NOW - 110_000).settled;
        const said = before.agents.get("c1")?.press;
        expect(before.agents.entry("c1")?.limitHold).toMatchObject({ reason: "stopped", pressOnly: true });

        // The restart: a daemon whose answer to a stop is to retry.
        const settings = { get: async () => SandboxSettingsSchema.parse({ stopPolicy: "retry" }), onSet: () => () => undefined };
        const standings = { of: () => "idle" as const, causesOf: () => [], refresh: async () => false, forget: () => {} };
        const after = await pressingFleet(createFleet(store, standings, noPresences(), { settings }));
        expect(restoreLimitHolds({ agents: after.agents, conversations: after.conversations, logger: silent })).toBe(1);
        expect(after.conversations.state("c1")?.resume.held).toMatchObject({ reason: "stopped", pressOnly: true, fired: false });
        expect(read(after, "c1")).toEqual({ status: "error", press: said });
        expect(said).toEqual({ kind: "continue", ending: { reason: "stopped", held: { ran: true, contextTokens: 9_000, pressOnly: true } } });
        expect(after.agents.get("c1")?.next).toBeUndefined();

        const services = unstubbed<Services>("services", {
            agents: after.agents,
            conversations: after.conversations,
            logger: silent,
            sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: settings.get }),
            resources: unstubbed<Services["resources"]>("resources", { roomSince: async () => undefined }),
            claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", { list: async () => [{ id: "acct", label: "a", connectedAt: 0 }] }),
            claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", { read: async () => ({}) }),
            accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => ({}) }),
            providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { onFile: async () => ({}) }),
            turns: after.turns,
        });
        for (const at of [NOW, NOW + 60_000, NOW + 60 * 60_000, NOW + 24 * 60 * 60_000]) {
            await createTurnResumeScheduler(services).tick(at);
            expect([at, after.started.length]).toEqual([at, 0]);
            expect(read(after, "c1")).toEqual({ status: "error", press: said });
        }

        await pressContinue(after, "c1");
        expect(after.started).toHaveLength(1);
        expect(after.started[0]).toMatchObject({ conversationId: "c1", resume: "stopped", sessionId: "s-1" });
        expect(read(after, "c1")).toEqual({ status: "running", press: { kind: "none" } });
    });
});

/* A TURN THE SANDBOX WAS BRINGING BACK WHEN THE DAEMON RESTARTED. A stop on an armed ladder, or an outage on an armed
   breaker, reads `resuming` with its entry left as the turn before it left it (comingBackNow): nothing is filed as its
   failure, since it is coming back. The hold is kept across a restart (limit-hold.ts), but the actor's word that it is
   coming back was not, so the card read `idle` with nothing to press over a held turn, and once the conversation's
   answer had become `wait` the pass never fired it nor withdrew the promise (held-standing.ts withdrawUnarmedResume asks
   for that word): the turn sat held under a card offering nothing, in every window. */
describe("a turn a restart caught coming back by itself", () => {
    const silent = pino({ level: "silent" });

    const restartedOn = async (wall: "stopped" | "outage", answerAfter: "retry" | "wait") => {
        const store = fleetStoreOver(openConversationsDb(IN_MEMORY));
        const before = memoryFleet(store);
        await before.agents.init();
        await beginTurn(before.conversations, { conversationId: "c1", isolated: true, prompt: "Fix the parser", profile: PROFILE }, NOW - 60_000);
        const code = wall === "outage" ? "provider-outage" : undefined;
        const plan = await classifyFailure({ kind: "error", code, message: "It stopped." }, contextOn("c1", NOW - 60_000, code), answering(true));
        before.conversations.send("c1", { kind: "frame", frame: plan.frame });
        if (plan.held === undefined) {
            throw new Error("expected a hold");
        }
        before.conversations.send("c1", { kind: "turn-held", held: plan.held }, NOW - 60_000);
        await before.conversations.send("c1", { kind: "settle" }, NOW - 55_000).settled;
        expect(before.agents.get("c1")).toMatchObject({ status: "resuming", press: { kind: "none" } });

        const policy = answerAfter;
        const settings = { get: async () => SandboxSettingsSchema.parse({ stopPolicy: policy, outagePolicy: policy }), onSet: () => () => undefined };
        const standings = { of: () => "idle" as const, causesOf: () => [], refresh: async () => false, forget: () => {} };
        const after = await pressingFleet(createFleet(store, standings, noPresences(), { settings }));
        expect(restoreLimitHolds({ agents: after.agents, conversations: after.conversations, logger: silent })).toBe(1);
        const services = unstubbed<Services>("services", {
            agents: after.agents,
            conversations: after.conversations,
            logger: silent,
            sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: settings.get }),
            resources: unstubbed<Services["resources"]>("resources", { roomSince: async () => undefined }),
            claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", { list: async () => [{ id: "acct", label: "a", connectedAt: 0 }] }),
            claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", { read: async () => ({}) }),
            accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => ({}) }),
            providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { onFile: async () => ({}) }),
            turns: { ...after.turns, drain: async () => {} },
        });
        return { after, pass: createTurnResumeScheduler(services) };
    };

    test.each(["stopped", "outage"] as const)("a %s still armed reads as coming back, then comes back", async (wall) => {
        const { after, pass } = await restartedOn(wall, "retry");
        expect(read(after, "c1")).toEqual({ status: "resuming", press: { kind: "none" } });
        await pass.tick(NOW + 60_000);
        expect(after.started).toHaveLength(1);
        expect(read(after, "c1")).toEqual({ status: "running", press: { kind: "none" } });
    });

    test.each(["stopped", "outage"] as const)("a %s whose answer is now to wait is offered for a press", async (wall) => {
        const { after, pass } = await restartedOn(wall, "wait");
        await pass.tick(NOW + 60_000);
        expect(after.started).toHaveLength(0);
        const { status, press } = read(after, "c1");
        expect([status, press?.kind]).toEqual(["error", "continue"]);
        // The press re-runs the very turn the restart kept.
        await pressContinue(after, "c1");
        expect(after.started[0]).toMatchObject({ conversationId: "c1", resume: wall });
    });
});

// A turn that reached its own iteration or time ceiling is held for a press alone (held-turn.ts pressOnly). Kept across
// a restart without that mark, it would come back as an ordinary stop, and the ladder the hold was kept off would re-run
// the very turn the ceiling stopped.


const quiet = pino({ level: "silent" });

// A conversation whose turn stopped and was held, settled on a fleet over `store`.
const stoppedOn = async (store: ReturnType<typeof fleetStoreOver>, pressOnly: boolean) => {
    const fleet = memoryFleet(store);
    await fleet.agents.init();
    await beginTurn(fleet.conversations, { conversationId: "c1", isolated: true, prompt: "Fix the parser", profile: PROFILE }, 1_000);
    const code = pressOnly ? "turn-cap" : undefined;
    fleet.conversations.send("c1", {
        kind: "frame",
        frame: { kind: "error", code, message: "Stopped short.", autoResume: "available", held: { ran: true } },
    });
    const input = { conversationId: "c1", prompt: "Fix the parser", ...PROFILE };
    const held = { input, reason: "stopped", ran: true, sessionId: "s-1", contextTokens: 9_000 } as const;
    fleet.conversations.send("c1", { kind: "turn-held", held: pressOnly ? { ...held, pressOnly: true } : held }, 1_500);
    await fleet.conversations.send("c1", { kind: "settle" }, 2_000).settled;
    return fleet;
};

describe("a stopped turn held for a press alone", () => {
    it("is kept on its entry as one, and a restart puts it back as one", async () => {
        const store = fleetStoreOver(openConversationsDb(IN_MEMORY));
        const before = await stoppedOn(store, true);
        expect(before.agents.entry("c1")?.limitHold).toMatchObject({ reason: "stopped", pressOnly: true, ran: true, sessionId: "s-1" });

        const after = memoryFleet(store);
        await after.agents.init();
        expect(restoreLimitHolds({ agents: after.agents, conversations: after.conversations, logger: quiet })).toBe(1);
        const [stranded] = after.conversations.stranded();
        expect(stranded?.record).toMatchObject({
            reason: "stopped",
            pressOnly: true,
            fired: false,
            tries: 0,
            ran: true,
            sessionId: "s-1",
            contextTokens: 9_000,
        });
    });

    it("leaves an ordinary stop's kept hold as it always was, on its ladder", async () => {
        const store = fleetStoreOver(openConversationsDb(IN_MEMORY));
        const before = await stoppedOn(store, false);
        expect(before.agents.entry("c1")?.limitHold).toMatchObject({ reason: "stopped", ran: true });
        expect(before.agents.entry("c1")?.limitHold?.pressOnly).toBeUndefined();

        const after = memoryFleet(store);
        await after.agents.init();
        expect(restoreLimitHolds({ agents: after.agents, conversations: after.conversations, logger: quiet })).toBe(1);
        const [stranded] = after.conversations.stranded();
        expect(stranded?.record).toMatchObject({ reason: "stopped", fired: false });
        expect(stranded?.record.pressOnly).toBeUndefined();
    });
});
