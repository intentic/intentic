import type { HandoffOffer } from "@intentic/sandbox-contract/schemas/providers/handoff";
import { RESUME_NOTES } from "@intentic/sandbox-contract/events/resume";
import { laneOf } from "@intentic/sandbox-contract/models/agent-lanes";
import type { ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { unstubbed } from "@intentic/testing";
import { IN_MEMORY } from "@intentic/base/sqlite";
import { pino } from "pino";
import { beginTurn } from "../../../conversations/actor/conversation-actors.testing.js";
import { fleetStoreOver } from "../../../conversations/registry/agents-registry.testing.js";
import { noPresences } from "../../../conversations/land/tests/landed-presence.testing.js";
import { openConversationsDb } from "../../../store/conversations-db.js";
import { createFleet } from "../../../conversations/registry/agents-registry.js";
import type { LandStandings } from "../../../conversations/land/standing.js";
import type { Services } from "../../../composition.js";
import type { TurnInput } from "../../../seams/turn-starter.js";
import { claudeLimitRefusal, claudeReading } from "../../providers/claude/claude-usage.testing.js";
import { createTurnResumeScheduler, handoffFor } from "./turn-resume.js";
import type { HeldOf, HeldTurn } from "./holds/held-turn.js";

// Which way a spent allowance's held turn continues: the press's word, then the person's pick on the card, then the
// suggestion, and never a way the destination cannot take.

const OFFER: HandoffOffer = {
    suggested: "trim",
    basis: "size",
    carry: { tokens: 420_000 },
    trim: { tokens: 110_000, cleared: 180 },
    summary: { tokens: 40_000, reads: 300_000 },
};

// The press as the editor sends it: the runtime it runs on, and here the same one the turn held.
const HERE = { agent: "claude", harness: "native" } as const;

const held = (over: Partial<Omit<HeldOf<"limit">, "reason" | "onto">> = {}): HeldTurn => ({
    input: { conversationId: "c1", prompt: "Fix the login bug", agent: "claude", harness: "native", account: "acct-1" },
    reason: "limit",
    sessionId: "s-1",
    ran: true,
    handoff: OFFER,
    ...over,
});

// A hold carries only what its own wall makes (HeldTurn): a reopen on a turn no allowance stopped, or a hold going to a
// booked move's account and a person's pick at once, does not compile. Only the stored record is flat (limit-hold.ts).
describe("a hold no wall makes", () => {
    it("does not compile", () => {
        const input = { conversationId: "c1", prompt: "p" };
        // @ts-expect-error: a stopped turn has no allowance to reopen.
        const stopped: HeldTurn = { input, reason: "stopped", ran: true, reopensAt: 100 };
        // @ts-expect-error: a booked move and a person's pick cannot both be where it goes.
        const both: HeldTurn = { input, reason: "limit", ran: true, move: { account: "a", carry: false }, onto: { account: "b", carry: false } };
        // @ts-expect-error: only a refused credential carries one to re-mint.
        const reminted: HeldTurn = { input, reason: "limit", ran: true, remint: { account: "a", refusedToken: "t" } };
        expect([stopped.reason, both.reason, reminted.reason]).toEqual(["stopped", "limit", "limit"]);
    });
});

describe("handoffFor", () => {
    it("takes the suggestion when nobody picked", () => {
        expect(handoffFor(held(), undefined)).toBe("trim");
    });

    it("takes the person's pick over the suggestion, and the press's word over both", () => {
        const picked = held({ handoff: { ...OFFER, chosen: "carry" } });
        expect(handoffFor(picked, undefined)).toBe("carry");
        expect(handoffFor(picked, { ...HERE, handoff: "summary" })).toBe("summary");
    });

    it("reads an older editor's carry as a pick to carry", () => {
        expect(handoffFor(held(), { ...HERE, carry: true })).toBe("carry");
    });

    it("falls to a summary when the press moves to a runtime holding no session", () => {
        expect(handoffFor(held(), { agent: "codex", harness: "native" })).toBe("summary");
    });

    it("never carries or trims a session the provider never answered in, or one another account refused", () => {
        expect(handoffFor(held({ ran: false }), { ...HERE, handoff: "carry" })).toBe("summary");
        expect(handoffFor(held({ carryRefused: true }), undefined)).toBe("summary");
    });

    it("leaves a hold with no offer, and every other wall, as it always was", () => {
        expect(handoffFor(held({ handoff: undefined }), { ...HERE, handoff: "trim" })).toBeUndefined();
        const outage: HeldTurn = { input: held().input, reason: "outage", sessionId: "s-1", ran: true };
        expect(handoffFor(outage, undefined)).toBeUndefined();
    });

    it("skips a way the offer does not have", () => {
        const { trim: _trim, ...noTrim } = OFFER;
        expect(handoffFor(held({ handoff: noTrim }), { ...HERE, handoff: "trim" })).toBe("summary");
    });
});

// The resume pass reads every hold once, then walks them, awaiting each re-run's start before the next. A hold that
// changes meanwhile (a new refusal replaces it, a pick re-points it) is judged again on the next pass: the copy the pass
// read is never what fires, and the hold as it now stands keeps its own booking.
describe("the resume pass fires only the hold it judged", () => {
    const standings = (): LandStandings => ({ of: () => "idle", causesOf: () => [], refresh: async () => false, forget: () => {} });
    const PROFILE = { agent: "claude", harness: "native" } as const;

    // Two conversations held behind one account, both due at the same reset (100 s), and a pass whose start of c0 waits
    // until the test lets it go, so the test can change c1's hold while the pass is busy.
    const twoHeld = async (prompts: { readonly c0: string; readonly c1: string }, account?: string) => {
        const { agents, conversations } = createFleet(fleetStoreOver(openConversationsDb(IN_MEMORY)), standings(), noPresences());
        await agents.init();
        for (const id of ["c0", "c1"] as const) {
            const prompt = prompts[id];
            await beginTurn(conversations, { conversationId: id, isolated: true, prompt, profile: PROFILE }, 1_000);
            const input = { conversationId: id, prompt, ...PROFILE, ...(account === undefined ? {} : { account }) };
            conversations.send(id, { kind: "turn-held", held: { input, reason: "limit", ran: true, reopensAt: 100 } }, 1_000);
            await conversations.send(id, { kind: "settle" }, 2_000).settled;
        }
        let releaseC0: () => void = () => {};
        const c0Started = new Promise<void>((resolve) => {
            releaseC0 = resolve;
        });
        const started: TurnInput[] = [];
        const services = {
            agents,
            conversations,
            logger: pino({ level: "silent" }),
            sandboxSettings: { get: async () => ({ limitPolicy: "resend", outagePolicy: "wait", stopPolicy: "wait", memoryPolicy: "resend" }) },
            resources: { roomSince: async () => undefined },
            turns: {
                drain: async () => {},
                start: async (input: TurnInput & { conversationId: string }) => {
                    started.push(input);
                    if (input.conversationId === "c0") {
                        await c0Started;
                    }
                    const outcome = await beginTurn(conversations, { conversationId: input.conversationId, isolated: true, prompt: input.prompt, profile: PROFILE }, 200_000);
                    return outcome === "begun" ? { id: `run-${input.conversationId}` } : outcome;
                },
            },
        } as unknown as Services;
        return { conversations, services, started, releaseC0, runsOf: (id: string) => started.filter((input) => input.conversationId === id) };
    };

    it("leaves a hold replaced while the pass was busy elsewhere to fire at its own reset, never the words it replaced", async () => {
        const { conversations, services, started, releaseC0, runsOf } = await twoHeld({ c0: "other work", c1: "old words" });
        const pass = createTurnResumeScheduler(services).tick(200_000);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(started.map((input) => input.conversationId)).toEqual(["c0"]);

        // The person sends new words on c1 at the reset: their turn supersedes the old hold and is refused once more,
        // leaving a hold for the new words, booked at 300 s.
        await beginTurn(conversations, { conversationId: "c1", isolated: true, prompt: "new words", profile: PROFILE }, 200_000);
        conversations.send("c1", { kind: "resume-superseded" });
        conversations.send("c1", { kind: "turn-held", held: { input: { conversationId: "c1", prompt: "new words", ...PROFILE }, reason: "limit", ran: false, reopensAt: 300 } }, 200_100);
        await conversations.send("c1", { kind: "settle" }, 200_200).settled;

        releaseC0();
        await pass;
        expect(runsOf("c1")).toEqual([]);
        expect(conversations.state("c1")?.resume.held).toMatchObject({ input: { prompt: "new words" }, fired: false, reopensAt: 300 });

        await createTurnResumeScheduler(services).tick(400_000);
        expect(runsOf("c1").map((input) => input.prompt)).toEqual([expect.stringContaining("new words")]);
        expect(runsOf("c1")[0]?.prompt).not.toContain("old words");
    });

    it("sends a hold re-pointed while the pass was busy on the picked account, at that account's reset", async () => {
        const { conversations, services, releaseC0, runsOf } = await twoHeld({ c0: "work", c1: "work" }, "acct-a");
        const pass = createTurnResumeScheduler(services).tick(200_000);
        await new Promise((resolve) => setTimeout(resolve, 20));
        // The person picks acct-b, spent too and back at 10 000 s (switch-account.ts, held-repointed).
        expect(conversations.send("c1", { kind: "held-repointed", account: "acct-b", carry: false, reopensAt: 10_000 }).reply).toBe(true);
        releaseC0();
        await pass;
        expect(runsOf("c1")).toEqual([]);
        expect(conversations.state("c1")?.resume.held).toMatchObject({ onto: { account: "acct-b" }, fired: false, reopensAt: 10_000 });

        await createTurnResumeScheduler(services).tick(10_000_000);
        expect(runsOf("c1").map((input) => input.account)).toEqual(["acct-b"]);
    });
});

/* A turn the sandbox held at the door for a spent allowance (spent-door.ts) never reached the model: re-run as a refused
   turn's is, it would open a fresh session and drop everything its conversation had built. It goes as a door's does. */
describe("a spent allowance's hold taken at the door", () => {
    const standings = (): LandStandings => ({ of: () => "idle", causesOf: () => [], refresh: async () => false, forget: () => {} });
    const PROFILE = { agent: "codex", harness: "native" } as const;

    const rerunOfHold = async (hold: Pick<HeldTurn, "ran" | "turnedAway" | "run">): Promise<TurnInput | undefined> => {
        const { agents, conversations } = createFleet(fleetStoreOver(openConversationsDb(IN_MEMORY)), standings(), noPresences());
        await agents.init();
        await beginTurn(conversations, { conversationId: "c1", isolated: true, prompt: "Port the EZD connector", profile: PROFILE }, 1_000);
        const input = { conversationId: "c1", prompt: "Port the EZD connector", sessionId: "thr-1", ...PROFILE };
        conversations.send("c1", { kind: "turn-held", held: { input, reason: "limit", reopensAt: 100, ...hold } }, 1_000);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        const started: TurnInput[] = [];
        const services = unstubbed<Services>("services", {
            agents,
            conversations,
            logger: pino({ level: "silent" }),
            // The owner's answer to a spent allowance is to send again at the reset, so the booking fires.
            sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({ limitPolicy: "resend" }) }),
            resources: unstubbed<Services["resources"]>("resources", { roomSince: async () => undefined }),
            turns: unstubbed<Services["turns"]>("turns", {
                drain: async () => {},
                start: async (turn) => {
                    started.push(turn);
                    return { id: "run-rerun", async *frames () {} };
                },
            }),
        });
        await createTurnResumeScheduler(services).tick(200_000);
        return started[0];
    };

    it("goes again on the session it was held on, as a door's does, its unsent run left unseen", async () => {
        const rerun = await rerunOfHold({ ran: false, turnedAway: true, run: "run-held" });

        expect(rerun?.sessionId).toBe("thr-1");
        expect(rerun?.resume).toBe("door");
        expect(rerun?.prompt).toContain(RESUME_NOTES.door);
        expect(rerun?.unseenRuns).toEqual(["run-held"]);
    });

    it("leaves a turn the provider itself refused before answering to open fresh, as it always did", async () => {
        const rerun = await rerunOfHold({ ran: false });

        expect(rerun?.sessionId).toBeUndefined();
        expect(rerun?.resume).toBe("refused");
    });
});

/* A person's words the pass would let go by itself (a memory hold once room comes back, a booking whose time came) go
   onto the account they name; where the records call it spent with a reopening ahead, they are booked for that reopening
   instead of sent into a refusal (allowance-gate.ts). On 2026-10-17 a held message went out twice into refusals before
   anyone could book it, the second time turning the person's words into a held turn re-run hours later. */
describe("the pass books words for the reopen rather than sending them into a spent allowance", () => {
    const standings = (): LandStandings => ({ of: () => "idle", causesOf: () => [], refresh: async () => false, forget: () => {} });
    const PROFILE = { agent: "claude", harness: "native", account: "acct-b" } as const;
    const NOW = 1_800_000_000_000;
    const REOPEN = NOW / 1000 + 8 * 60 * 60;
    // acct-b as the Claude reader files it, and at 100 the refusal on file that alone proves it spent (its pools are rounded).
    const usage = (utilization: number) => claudeReading({ five_hour: { utilization, resetsAt: REOPEN } }, NOW);
    const refusedAt = (utilization: number) => (utilization < 100 ? [] : [claudeLimitRefusal({ account: "acct-b", resetsAt: REOPEN, at: NOW - 60_000 })]);

    const conversation = async (utilization: number) => {
        const { agents, conversations } = createFleet(fleetStoreOver(openConversationsDb(IN_MEMORY)), standings(), noPresences());
        await agents.init();
        const started: TurnInput[] = [];
        const drained: string[] = [];
        const services = unstubbed<Services>("services", {
            agents,
            conversations,
            logger: pino({ level: "silent" }),
            sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({ memoryPolicy: "resend" }) }),
            // Memory has long been free: only the allowance can keep the words back.
            resources: unstubbed<Services["resources"]>("resources", { roomSince: async () => NOW - 60 * 60_000 }),
            claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", { list: async () => [{ id: "acct-b", label: "acct-b", connectedAt: 0 }] }),
            claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", { read: async () => ({}) }),
            accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => ({ "acct-b": usage(utilization) }) }),
            providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { onFile: async () => ({ claude: refusedAt(utilization) }) }),
            turns: unstubbed<Services["turns"]>("turns", {
                drain: async (id) => void drained.push(id),
                start: async (turn) => {
                    started.push(turn);
                    return { id: "run-x", async *frames() {} };
                },
            }),
        });
        return { agents, conversations, services, started, drained };
    };
    const words = (id: string, prompt: string) => ({ id, voice: "person" as const, queuedAt: NOW, turn: { conversationId: "c1", prompt, ...PROFILE } });

    // Turned away for memory: the entry ends failed on the room code, the words held at the queue's head.
    const heldForMemory = async (utilization: number) => {
        const fleet = await conversation(utilization);
        await beginTurn(fleet.conversations, { conversationId: "c1", isolated: true, prompt: "Fix the images", profile: PROFILE }, NOW - 120_000);
        fleet.conversations.send("c1", { kind: "frame", frame: { kind: "error", code: "sandbox-memory-low", message: "Sandbox memory is low." } }, NOW - 120_000);
        await fleet.conversations.send("c1", { kind: "settle" }, NOW - 110_000).settled;
        fleet.conversations.send("c1", { kind: "queue-returned", items: [words("m-1", "Fix the images")] }, NOW - 110_000);
        return fleet;
    };

    it("books memory-held words for the reopen of the spent account they go on, and sends nothing", async () => {
        const { conversations, services, drained } = await heldForMemory(100);
        expect(conversations.queued("c1").paused).toBe("refused");

        await createTurnResumeScheduler(services).tick(NOW);
        expect(drained).toEqual([]);
        const queue = conversations.queued("c1");
        // Booked as the reopen it is, on the account it waits out, so every window can tell it from a chosen time.
        expect(queue.items).toMatchObject([{ id: "m-1", until: REOPEN * 1000, reopenOf: { agent: "claude", account: "acct-b" } }]);
        // Booked, the hold is answered: the queue reads scheduled, and no memory hold is left for a later pass.
        expect(queue.paused).toBe("scheduled");
    });

    it("lets memory-held words go once memory frees where their account has room", async () => {
        const { conversations, services, drained } = await heldForMemory(40);
        await createTurnResumeScheduler(services).tick(NOW);
        expect(drained).toEqual(["c1"]);
        expect(conversations.queued("c1").items[0]?.until).toBeUndefined();
    });

    it("books a booking whose time came again for the reopen, while the account still reads spent", async () => {
        const { conversations, services, drained } = await conversation(100);
        conversations.send("c1", { kind: "queue-scheduled", item: words("m-at", "Continue the review"), booking: { until: NOW - 1_000 } }, NOW - 60_000);

        await createTurnResumeScheduler(services).tick(NOW);
        expect(drained).toEqual([]);
        expect(conversations.queued("c1").items).toMatchObject([{ id: "m-at", until: REOPEN * 1000 }]);
    });

    it("lets a booking whose time came go when its account has room", async () => {
        const { conversations, services, drained } = await conversation(40);
        conversations.send("c1", { kind: "queue-scheduled", item: words("m-at", "Continue the review"), booking: { until: NOW - 1_000 } }, NOW - 60_000);

        await createTurnResumeScheduler(services).tick(NOW);
        expect(drained).toEqual(["c1"]);
    });
});

/* A STRANDED CARD'S LANE FOLLOWS WHAT THE PASS WILL DO (2026-10-19). Three Codex conversations were answered "Send
   again" on one account; the one whose refusal named "try again at 1:53 PM" moved to Active, while the two refused minutes
   later with a bare 429 stayed in Attention: their holds had no instant, so the answer booked nothing and nothing ever
   would. Each beat now times such a hold once the records know its pool's reopen, and holds every card's booking, and a
   "resuming" card's promise, to what this pass will actually do. */
describe("a stranded card's lane follows what the pass will do", () => {
    const standings = (): LandStandings => ({ of: () => "idle", causesOf: () => [], refresh: async () => false, forget: () => {} });
    const PROFILE = { agent: "codex", harness: "native", account: "codex-subscription" } as const;
    const NOW = 1_800_000_000_000;
    const REOPEN = NOW / 1000 + 2 * 60 * 60;
    const PROMPT = "Fix the header flicker";

    const fleet = async (settings: Record<string, unknown>, refusals: readonly ProviderRefusal[] = []) => {
        let current = SandboxSettingsSchema.parse(settings);
        // The registry follows the settings the pass reads, as composition wires it, and hears every write.
        const written = new Set<() => void>();
        const onSet = (listener: () => void): (() => void) => {
            written.add(listener);
            return () => written.delete(listener);
        };
        const followed = { get: async () => current, onSet };
        const { agents, conversations } = createFleet(fleetStoreOver(openConversationsDb(IN_MEMORY)), standings(), noPresences(), { settings: followed });
        await agents.init();
        const services = unstubbed<Services>("services", {
            agents,
            conversations,
            logger: pino({ level: "silent" }),
            sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => current }),
            resources: unstubbed<Services["resources"]>("resources", { roomSince: async () => undefined }),
            accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => ({}) }),
            // No Codex credential the translator lists: nothing on file says the model is spent.
            cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", { accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [] }) }),
            providerAccounts: async () => [],
            providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { onFile: async () => ({ codex: refusals }) }),
            turns: unstubbed<Services["turns"]>("turns", { drain: async () => {} }),
        });
        const lane = (): string | undefined => {
            const summary = agents.get("c1");
            return summary === undefined ? undefined : laneOf(summary);
        };
        const answer = (next: Record<string, unknown>): void => {
            current = SandboxSettingsSchema.parse(next);
            for (const listener of written) {
                listener();
            }
        };
        return { agents, conversations, services, lane, answer };
    };

    // Refused for a spent allowance, as classify-failure dresses it: held, with the reset where the refusal knew one.
    const refused = async (at: Awaited<ReturnType<typeof fleet>>, reopensAt?: number) => {
        await beginTurn(at.conversations, { conversationId: "c1", isolated: true, prompt: PROMPT, profile: PROFILE }, NOW - 120_000);
        const frame = { kind: "error" as const, code: "rate_limit" as const, message: "429", held: { ran: true } };
        at.conversations.send("c1", { kind: "frame", frame: reopensAt === undefined ? frame : { ...frame, resetsAt: reopensAt, autoResume: "available" } }, NOW - 120_000);
        const input = { conversationId: "c1", prompt: PROMPT, ...PROFILE, model: "gpt-6.1-sol" };
        const hold = { input, reason: "limit" as const, ran: true };
        at.conversations.send("c1", { kind: "turn-held", held: reopensAt === undefined ? hold : { ...hold, reopensAt } }, NOW - 120_000);
        await at.conversations.send("c1", { kind: "settle" }, NOW - 110_000).settled;
    };

    it("times a hold refused with no reset once the records know its pool's reopen, so its Send again goes then", async () => {
        const sibling: ProviderRefusal = { at: NOW - 240_000, kind: "limit", message: "try again at 1:53 PM", model: "gpt-6.1-sol", resetsAt: REOPEN };
        const at = await fleet({ limitPolicy: "resend" }, [sibling]);
        await refused(at);
        expect(at.lane()).toBe("attention");

        await createTurnResumeScheduler(at.services).tick(NOW);
        expect(at.conversations.state("c1")?.resume.held).toMatchObject({ reopensAt: REOPEN, fired: false });
        expect(at.agents.get("c1")).toMatchObject({ limitResetsAt: REOPEN, next: { kind: "rerun", at: REOPEN * 1000 } });
        expect(at.lane()).toBe("active");
    });

    it("leaves a hold the records cannot time in Attention, where only a press sends it", async () => {
        const at = await fleet({ limitPolicy: "resend" });
        await refused(at);
        await createTurnResumeScheduler(at.services).tick(NOW);
        expect(at.conversations.state("c1")?.resume.held?.reopensAt).toBeUndefined();
        expect(at.lane()).toBe("attention");
    });

    // Only a conversation's own answer used to re-book its card; the sandbox-wide one, changed in Settings, left every
    // held card filed by the answer it had when its turn was refused, while the pass acted on the new one.
    it("re-files every held card within a beat when the sandbox-wide answer changes", async () => {
        const at = await fleet({ limitPolicy: "wait" });
        await refused(at, REOPEN);
        await createTurnResumeScheduler(at.services).tick(NOW);
        expect(at.lane()).toBe("attention");

        at.answer({ limitPolicy: "resend" });
        await createTurnResumeScheduler(at.services).tick(NOW);
        expect(at.agents.get("c1")?.next).toMatchObject({ kind: "rerun" });
        expect(at.lane()).toBe("active");

        at.answer({ limitPolicy: "wait" });
        await createTurnResumeScheduler(at.services).tick(NOW);
        expect(at.agents.get("c1")?.next).toBeUndefined();
        expect(at.lane()).toBe("attention");
    });

    // An armed stop reads "resuming", in Active. Answered "wait" afterwards, the pass returned before its rung for good,
    // and the card sat in Active with nothing ever to move it.
    it("withdraws a resuming card's promise once its answer is to wait, leaving the hold for a press", async () => {
        const at = await fleet({ stopPolicy: "retry" });
        await beginTurn(at.conversations, { conversationId: "c1", isolated: true, prompt: PROMPT, profile: PROFILE }, NOW - 120_000);
        at.conversations.send("c1", { kind: "frame", frame: { kind: "error", message: "stopped short", autoResume: "scheduled", held: { ran: true } } }, NOW - 120_000);
        at.conversations.send("c1", { kind: "turn-held", held: { input: { conversationId: "c1", prompt: PROMPT, ...PROFILE }, reason: "stopped", ran: true } }, NOW - 120_000);
        await at.conversations.send("c1", { kind: "settle" }, NOW - 110_000).settled;
        expect(at.agents.get("c1")?.status).toBe("resuming");
        expect(at.lane()).toBe("active");

        at.answer({ stopPolicy: "wait" });
        await createTurnResumeScheduler(at.services).tick(NOW);
        expect(at.agents.get("c1")?.status).toBe("error");
        expect(at.lane()).toBe("attention");
        expect(at.conversations.state("c1")?.resume.held).toMatchObject({ reason: "stopped", fired: false });
    });
});

/* NOTHING THE PASS SENDS GOES INTO AN ALLOWANCE THE RECORDS CALL SPENT (2026-10-19). Two conversations were moved from
   one spent Claude account to another; the pick judged the second open off its rounded reading, stored "now" on each
   hold, and the next beat sent both turns to be refused within seconds, while the composer counted down to 20:10. The
   pass now reads the allowance wall in front of where a hold goes before it sends it, whatever the hold stored. */
describe("the pass never sends a held turn into an allowance the records call spent", () => {
    const standings = (): LandStandings => ({ of: () => "idle", causesOf: () => [], refresh: async () => false, forget: () => {} });
    const PROFILE = { agent: "claude", harness: "native", account: "acct-a" } as const;
    const NOW = 1_800_000_000_000;
    const REOPEN = NOW / 1000 + 25 * 60;
    // acct-b as the Claude reader files it: every pool rounded, so the reading alone never proves it spent; the refusal
    // on file does, until the instant the provider named.
    const ROUNDED_FULL = claudeReading({ five_hour: { utilization: 100, resetsAt: REOPEN } }, NOW);
    const REFUSED = claudeLimitRefusal({ account: "acct-b", resetsAt: REOPEN, at: NOW - 60_000, model: "opus" });

    const fleet = async () => {
        // One settings document, read by the pass and followed by the registry, as composition wires them.
        const settings = { get: async () => SandboxSettingsSchema.parse({ limitPolicy: "resend", stopPolicy: "retry" }), onSet: () => () => undefined };
        const { agents, conversations } = createFleet(fleetStoreOver(openConversationsDb(IN_MEMORY)), standings(), noPresences(), { settings });
        await agents.init();
        const started: TurnInput[] = [];
        const services = unstubbed<Services>("services", {
            agents,
            conversations,
            logger: pino({ level: "silent" }),
            sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: settings.get }),
            resources: unstubbed<Services["resources"]>("resources", { roomSince: async () => undefined }),
            claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", {
                list: async () => [
                    { id: "acct-a", label: "a", connectedAt: 0 },
                    { id: "acct-b", label: "b", connectedAt: 0 },
                ],
            }),
            claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", { read: async () => ({}) }),
            accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => ({ "acct-b": ROUNDED_FULL }) }),
            providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { onFile: async () => ({ claude: [REFUSED] }) }),
            turns: unstubbed<Services["turns"]>("turns", {
                drain: async () => {},
                start: async (turn) => {
                    started.push(turn);
                    return { id: `run-${started.length}`, async *frames() {} };
                },
            }),
        });
        return { agents, conversations, services, started };
    };

    // Refused on acct-a for a spent allowance, held, its card booked for acct-a's reset an hour out.
    const refusedOnA = async (at: Awaited<ReturnType<typeof fleet>>) => {
        await beginTurn(at.conversations, { conversationId: "c1", isolated: true, prompt: "Fix the gallery", profile: PROFILE }, NOW - 120_000);
        const frame = { kind: "error" as const, code: "rate_limit" as const, message: "Claude usage limit reached.", held: { ran: true }, resetsAt: NOW / 1000 + 3_600, autoResume: "scheduled" as const };
        at.conversations.send("c1", { kind: "frame", frame }, NOW - 120_000);
        const input = { conversationId: "c1", prompt: "Fix the gallery", ...PROFILE, model: "opus" };
        at.conversations.send("c1", { kind: "turn-held", held: { input, reason: "limit", ran: true, reopensAt: NOW / 1000 + 3_600 } }, NOW - 120_000);
        await at.conversations.send("c1", { kind: "settle" }, NOW - 110_000).settled;
    };

    it("holds a turn re-pointed for now onto an account a refusal proves spent, and its card says when it really goes", async () => {
        const at = await fleet();
        await refusedOnA(at);
        // A pick that read acct-b as open stored "now" on the hold, as switch-account.ts did before 2026-10-19.
        expect(at.conversations.send("c1", { kind: "held-repointed", account: "acct-b", carry: true, reopensAt: NOW / 1000 }).reply).toBe(true);

        await createTurnResumeScheduler(at.services).tick(NOW);
        expect(at.started).toEqual([]);
        expect(at.conversations.state("c1")?.resume.held).toMatchObject({ fired: false, onto: { account: "acct-b" } });
        expect(at.agents.get("c1")).toMatchObject({ next: { kind: "rerun", at: REOPEN * 1000 } });

        await createTurnResumeScheduler(at.services).tick(REOPEN * 1000 + 1_000);
        expect(at.started.map((turn) => turn.account)).toEqual(["acct-b"]);
    });

    it("holds a stopped turn's due rung while the account it goes on is spent, and sends it once that reopens", async () => {
        const at = await fleet();
        await beginTurn(at.conversations, { conversationId: "c1", isolated: true, prompt: "Fix the gallery", profile: PROFILE }, NOW - 120_000);
        const input = { conversationId: "c1", prompt: "Fix the gallery", ...PROFILE, account: "acct-b", model: "opus" };
        at.conversations.send("c1", { kind: "turn-held", held: { input, reason: "stopped", ran: true } }, NOW - 120_000);
        await at.conversations.send("c1", { kind: "settle" }, NOW - 110_000).settled;

        await createTurnResumeScheduler(at.services).tick(NOW);
        expect(at.started).toEqual([]);
        expect(at.conversations.state("c1")?.resume.held).toMatchObject({ reason: "stopped", fired: false, tries: 0 });

        await createTurnResumeScheduler(at.services).tick(REOPEN * 1000 + 1_000);
        expect(at.started.map((turn) => turn.account)).toEqual(["acct-b"]);
    });
});
