import type { HandoffOffer } from "@intentic/sandbox-contract";
import { IN_MEMORY } from "@intentic/base/sqlite";
import { pino } from "pino";
import { beginTurn, fleetStoreOver, noPresences } from "../../../testing.js";
import { openConversationsDb } from "../../../store/conversations-db.js";
import { createFleet } from "../../../conversations/registry/agents-registry.js";
import type { LandStandings } from "../../../conversations/land/standing.js";
import type { Services } from "../../../composition.js";
import type { TurnInput } from "../../../seams/turn-starter.js";
import { createTurnResumeScheduler, handoffFor, type HeldTurn } from "./turn-resume.js";

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

const held = (over: Partial<HeldTurn> = {}): HeldTurn => ({
    input: { conversationId: "c1", prompt: "Fix the login bug", agent: "claude", harness: "native", account: "acct-1" },
    reason: "limit",
    sessionId: "s-1",
    ran: true,
    handoff: OFFER,
    ...over,
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
        expect(handoffFor(held({ reason: "outage" }), undefined)).toBeUndefined();
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
