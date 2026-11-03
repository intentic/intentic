import type { HandoffOffer } from "@intentic/sandbox-contract/schemas/providers/handoff";
import { unstubbed } from "@intentic/testing";
import { IN_MEMORY } from "@intentic/base/sqlite";
import { beginTurn } from "../../../../conversations/actor/conversation-actors.testing.js";
import { fleetStoreOver } from "../../../../conversations/registry/agents-registry.testing.js";
import { noPresences } from "../../../../conversations/land/tests/landed-presence.testing.js";
import { openConversationsDb } from "../../../../store/conversations-db.js";
import { createFleet } from "../../../../conversations/registry/agents-registry.js";
import type { LandStandings } from "../../../../conversations/land/standing.js";
import type { Services } from "../../../../composition.js";
import type { RoutedTurn } from "../../../../seams/turn-starter.js";
import { handoffOfferOf } from "../../../providers/limit-handoff.js";
import { carriedHandoff, handoffWayOf, keptHandoffOf, replaceHeld, withoutSession, withUnsentWords } from "../holds/handoff-way.js";
import type { HeldOf, HeldTurn } from "../holds/held-turn.js";
import { RESUME_NOTES, withResumeNote } from "@intentic/sandbox-contract/events/resume";
import { ATTACHMENT_LIMIT } from "@intentic/sandbox-contract/schemas/agent";

/* proud-meadow-86lu, 2026-10-26: a Codex turn held for a spent allowance, its card reading Summary. A "Continue" booked
   for the reset took the held turn's place and went on the old session whole, and when that was refused at the reset
   the re-run opened fresh with the bare record: no summary was ever written. The words that take a held turn's place now
   go on the hold's pick, and a refusal that runs nothing keeps the summary they were going on by. */

const OFFER: HandoffOffer = {
    suggested: "trim",
    basis: "size",
    carry: { tokens: 420_000 },
    trim: { tokens: 110_000, cleared: 180 },
    summary: { tokens: 40_000, reads: 300_000 },
};

const HELD_INPUT = { conversationId: "c1", prompt: "Port the EZD connector", agent: "codex", harness: "native", account: "acct-1" } as const;

const held = (over: Partial<Omit<HeldOf<"limit">, "reason" | "onto">> = {}): HeldOf<"limit"> => ({
    input: HELD_INPUT,
    reason: "limit",
    sessionId: "thr-1",
    ran: true,
    contextTokens: 420_000,
    handoff: OFFER,
    ...over,
});

// The turn as it reaches the runtime: routed, on the held turn's own runtime unless a case moves it.
const turn = (over: Partial<RoutedTurn> = {}): RoutedTurn => ({ conversationId: "c1", prompt: "Continue", agent: "codex", harness: "native", account: "acct-1", ...over });

describe("which way a turn goes on from the held turn it takes the place of", () => {
    test("new words go on the person's pick on the card, a summary opening fresh", () => {
        expect(handoffWayOf(turn(), held({ handoff: { ...OFFER, chosen: "summary" } }))).toBe("summary");
    });

    test("new words nobody picked a way for go on the card's suggestion", () => {
        expect(handoffWayOf(turn(), held())).toBe("trim");
    });

    // Another provider holds no session of this one: a pick to carry falls to the summary the offer has.
    test("new words onto another runtime never carry a session it cannot read", () => {
        const picked = held({ handoff: { ...OFFER, chosen: "carry" } });
        expect(handoffWayOf(turn(), picked)).toBe("carry");
        expect(handoffWayOf(turn({ agent: "claude", account: undefined }), picked)).toBe("summary");
    });

    test("new words on a hold with no offer, another wall's hold, or none, go on as they always did", () => {
        expect(handoffWayOf(turn(), held({ handoff: undefined }))).toBeUndefined();
        expect(handoffWayOf(turn(), { input: HELD_INPUT, reason: "outage", sessionId: "thr-1", ran: true })).toBeUndefined();
        expect(handoffWayOf(turn(), undefined)).toBeUndefined();
    });

    test("a re-run goes the way its press already named", () => {
        expect(handoffWayOf(turn({ resume: "summarized" }), held())).toBe("summary");
        expect(handoffWayOf(turn({ resume: "trimmed" }), held())).toBe("trim");
        expect(handoffWayOf(turn({ resume: "limit" }), held())).toBe("carry");
        expect(handoffWayOf(turn({ resume: "carried" }), held())).toBe("carry");
        // Carrying is only a way among others where the hold offered a choice.
        expect(handoffWayOf(turn({ resume: "limit" }), held({ handoff: undefined }))).toBeUndefined();
        expect(handoffWayOf(turn({ resume: "door" }), held())).toBeUndefined();
    });
});

describe("the way a turn keeps for a refusal that runs nothing", () => {
    test("a summary it was going on by, with the pick that chose it", () => {
        const picked = held({ handoff: { ...OFFER, chosen: "summary" } });
        expect(keptHandoffOf({ held: picked, way: "summary" })).toStrictEqual({ suggested: "summary", basis: "size", summary: OFFER.summary, chosen: "summary" });
    });

    // Its session is gone either way (the re-run opens fresh): carrying or trimming one is no longer on offer.
    test("only the summary, whatever else the hold offered or was picked", () => {
        expect(keptHandoffOf({ held: held(), way: "summary" })).toStrictEqual({ suggested: "summary", basis: "size", summary: OFFER.summary });
        const pickedCarry = held({ handoff: { ...OFFER, chosen: "carry" } });
        expect(keptHandoffOf({ held: pickedCarry, way: "summary" })).not.toHaveProperty("chosen");
    });

    test("nothing for a turn going on any other way, or from a hold with no summary to keep", () => {
        expect(keptHandoffOf({ held: held(), way: "carry" })).toBeUndefined();
        expect(keptHandoffOf({ held: held(), way: "trim" })).toBeUndefined();
        expect(keptHandoffOf({ held: held(), way: undefined })).toBeUndefined();
        const { summary: _none, ...noSummary } = OFFER;
        expect(keptHandoffOf({ held: held({ handoff: noSummary }), way: "summary" })).toBeUndefined();
        expect(keptHandoffOf({ held: undefined, way: "summary" })).toBeUndefined();
    });

    // A turn that never ran offers nothing of its own session; what it kept is the one way on its hold still has.
    test("is the offer its refusal's hold carries, where it ran nothing", async () => {
        const kept = keptHandoffOf({ held: held({ handoff: { ...OFFER, chosen: "summary" } }), way: "summary" });
        const services = unstubbed<Services>("services", {});
        const params = { turn: { ...turn(), conversationId: "c1" }, sessionId: undefined, contextTokens: undefined, handoffTokens: 1_200, rows: [] };
        expect(await handoffOfferOf(services, { ...params, ran: false, kept })).toBe(kept);
        expect(await handoffOfferOf(services, { ...params, ran: false })).toBeUndefined();
    });
});

describe("what a turn going on from a held one does to its own session", () => {
    test("a summary drops the session and the cut it would resume at, and nothing else", () => {
        const resuming = turn({ sessionId: "thr-1", resumeAt: "msg-9", model: "gpt-6.1-sol" });
        expect(withoutSession(resuming)).toStrictEqual(turn({ model: "gpt-6.1-sol" }));
    });

    test("carrying is said, with what it re-reads, only where the session was resumed", () => {
        expect(carriedHandoff("carry", held(), "thr-1")).toStrictEqual({ mode: "carry", tokens: 420_000 });
        // A session the runtime no longer held opened fresh: that is no carrying.
        expect(carriedHandoff("carry", held(), undefined)).toBeUndefined();
        expect(carriedHandoff("summary", held(), "thr-1")).toBeUndefined();
        expect(carriedHandoff("carry", held({ handoff: undefined }), "thr-1")).toBeUndefined();
    });
});

describe("a turn replacing the held one", () => {
    const standings = (): LandStandings => ({ of: () => "idle", causesOf: () => [], refresh: async () => false, forget: () => {} });
    const PROFILE = { agent: "codex", harness: "native" } as const;

    test("supersedes the hold and goes on the way it offered", async () => {
        const { agents, conversations } = createFleet(fleetStoreOver(openConversationsDb(IN_MEMORY)), standings(), noPresences());
        await agents.init();
        await beginTurn(conversations, { conversationId: "c1", isolated: true, prompt: HELD_INPUT.prompt, profile: PROFILE }, 1_000);
        conversations.send("c1", { kind: "turn-held", held: held({ handoff: { ...OFFER, chosen: "summary" }, reopensAt: 100 }) }, 1_000);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;

        const replaced = replaceHeld({ conversations }, turn());
        expect(replaced.way).toBe("summary");
        expect(replaced.held).toMatchObject({ input: { prompt: HELD_INPUT.prompt }, handoff: { chosen: "summary" } });
        expect(conversations.state("c1")?.resume.held).toBeUndefined();
    });

    test("supersedes nothing for a turn with no conversation", () => {
        const conversations = unstubbed<Services["conversations"]>("conversations", {});
        expect(replaceHeld({ conversations }, turn({ conversationId: undefined }))).toStrictEqual({ held: undefined, way: undefined });
    });
});

/* Gap 6, 2026-11-03: a person's turn a spent allowance refused before the model answered stays drawn in the chat under
   its "Limit reached", held for Continue. The person typed something new instead, and the new turn superseded the hold:
   the session it resumed never read the refused words, so the model answered only the new ones while the chat showed
   both sent. The new words now go out behind the ones nothing ever read. */
describe("a person's new words over a held turn no model read", () => {
    const ADA = { actor: "ada@example.com", speaker: { kind: "person", email: "ada@example.com" } } as const;
    const refused = (over: Partial<HeldTurn["input"]> = {}, hold: Partial<HeldOf<"limit">> = {}): HeldTurn =>
        held({ input: { ...HELD_INPUT, ...ADA, ...over }, ran: false, handoff: undefined, ...hold });
    const said = (over: Partial<RoutedTurn> = {}): RoutedTurn => turn({ prompt: "and add a test for it", ...ADA, ...over });

    test("go out behind the held words, as one person's messages in a row are joined", () => {
        expect(withUnsentWords(said(), refused()).prompt).toBe("Port the EZD connector\n\nand add a test for it");
    });

    test("carry the held turn's files and mentions with them, each once", () => {
        const joined = withUnsentWords(said({ attachments: ["b.png"], mentions: ["src/a.ts", "a.png"] }), refused({ attachments: ["a.png"], mentions: ["src/a.ts"] }));
        expect(joined.attachments).toStrictEqual(["a.png", "b.png"]);
        expect(joined.mentions).toStrictEqual(["src/a.ts"]);
    });

    // A re-run whose own note says nothing was read (the press's `refused`, a door's): the words without the note.
    test("carry a re-run's words without the note it was sent with, where that note says nothing was read", () => {
        for (const resume of ["refused", "door"] as const) {
            const rerun = refused({ prompt: withResumeNote(HELD_INPUT.prompt, RESUME_NOTES[resume]), resume });
            expect(withUnsentWords(said(), rerun).prompt).toBe("Port the EZD connector\n\nand add a test for it");
        }
    });

    // The door's run is recorded but never seen: a fresh session seeded from the record must not read the words twice.
    test("count a door's run among the runs the model never saw", () => {
        const door: HeldTurn = { input: { ...HELD_INPUT, ...ADA }, reason: "door", ran: false, run: "run-door" };
        expect(withUnsentWords(said({ unseenRuns: ["run-0"] }), door)).toMatchObject({ prompt: "Port the EZD connector\n\nand add a test for it", unseenRuns: ["run-0", "run-door"] });
    });

    const UNCHANGED: readonly [string, RoutedTurn, HeldTurn | undefined][] = [
        ["nothing is held", said(), undefined],
        ["the held turn answered, so its session has its words", said(), refused({}, { ran: true })],
        ["a press re-runs the held turn itself", said({ resume: "refused" }), refused()],
        ["a flagged turn's words would only meet the same classifier", said(), { input: { ...HELD_INPUT, ...ADA }, reason: "flagged", ran: false }],
        ["another person's words: a turn has one owner", said({ actor: "bo@example.com", speaker: { kind: "person", email: "bo@example.com" } }), refused()],
        ["the held words were the sandbox's", said(), refused({ speaker: { kind: "sandbox", source: "watch" } })],
        ["the new words are a child's report", said({ speaker: { kind: "agent", conversationId: "child" } }), refused()],
        ["the held turn re-ran words a model already read", said(), refused({ prompt: withResumeNote(HELD_INPUT.prompt, RESUME_NOTES.stopped), resume: "stopped" })],
        ["the new words are a command the harness reads only at the start", said({ prompt: "/compact" }), refused()],
        ["the held words were a command", said(), refused({ prompt: "/review" })],
        ["together they carry more files than one turn may", said({ attachments: Array.from({ length: ATTACHMENT_LIMIT }, (_, i) => `n${i}.png`) }), refused({ attachments: ["a.png"] })],
    ];
    test.each(UNCHANGED)("go as they were sent where %s", (_, input, hold) => {
        expect(withUnsentWords(input, hold)).toBe(input);
    });
});
