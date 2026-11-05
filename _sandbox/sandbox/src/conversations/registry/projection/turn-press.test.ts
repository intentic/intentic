import { IN_MEMORY } from "@intentic/base/sqlite";
import type { TurnEnding } from "@intentic/sandbox-contract/events/transcript";
import { FAILURE_CODES, type FailureCourse, failureCourseOf } from "@intentic/sandbox-contract/policy/failure-codes";
import type { AgentPress } from "@intentic/sandbox-contract/schemas/agent-press";
import type { AgentNext } from "@intentic/sandbox-contract/schemas/agent-next";
import { AgentStatusSchema, type AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { type HeldEnding, RETRY_LADDER_TRIES } from "@intentic/sandbox-contract/schemas/turn-break";
import type { HeldReason } from "../../../agent/run/turn/holds/held-turn.js";
import { openConversationsDb } from "../../../store/conversations-db.js";
import { beginTurn } from "../../actor/conversation-actors.testing.js";
import type { HeldRecord } from "../../actor/conversation-state.js";
import { sendableAt } from "../../actor/limit-booking.js";
import type { Fleet } from "../agents-registry.js";
import { fleetStoreOver, memoryFleet } from "../agents-registry.testing.js";
import type { Ending, PersistedAgent } from "../agents-store.js";
import { conversationEntry } from "../agents-store.testing.js";
import { endingOf, type EndingFacts, pressOf, turnEndingOf } from "./turn-ending.js";
import { opt } from "../../../opt.js";

/* WHAT A PERSON'S CONTINUE DOES, AS THE CARD SAYS IT (AgentSummary.press) AND AS THE RECORD SAYS IT (the transcript's
   `ending`): one reading, pinned here over every status, stored ending, held turn and booking. The chat's strip follows
   the card; when the two said different things, a card in Finished stood beside a composer offering a limit's Continue
   (2026-11-01, true-pine-bgzz), and a reloaded window lost its strip or kept one nothing would act on. */

const NOW = 1_800_000_000_000;
const RESET = NOW / 1000 + 3_600;

// What each failure course leaves a press to carry on, by the reason its ending names; nothing for a course a press would
// only re-fail (a fix outside the conversation, a refusal at the door, a remedy the daemon runs by itself).
const REASON_OF_COURSE = {
    limit: "limit",
    outage: "outage",
    flagged: "flagged",
    carry: "stopped",
    door: undefined,
    remint: undefined,
    overflow: undefined,
    bare: undefined,
    note: undefined,
} as const satisfies Record<FailureCourse, HeldEnding | undefined>;

// The held turn as an ending says it: whether it ran, what each way on costs, where a booked move takes it, and that
// only a press sends it again.
const heldSaid = (held: HeldRecord): NonNullable<TurnEnding["held"]> => ({
    ran: held.ran,
    ...opt("contextTokens", held.contextTokens),
    ...opt("handoffTokens", held.handoffTokens),
    ...opt("moving", held.move?.account),
    ...opt("pressOnly", held.pressOnly === true ? true : undefined),
});

// The spec, field by field: a Stop or a killed daemon carries on in the session (no hold said, as the record always
// said); an error carries on by its course; an outage names nothing held, since its breaker owns the re-run; a stopped
// hold counts the ladder's rungs unless only a press sends it; a spent allowance states its reset and its booking.
const spec = (card: EndingFacts, held: HeldRecord | undefined, now: number): TurnEnding | undefined => {
    if (card.status === "stopped" || card.status === "interrupted") {
        return { reason: "stopped" };
    }
    const reason = card.status === "error" ? REASON_OF_COURSE[failureCourseOf(card.failureCode)] : undefined;
    if (reason === undefined) {
        return undefined;
    }
    if (reason === "outage") {
        return { reason };
    }
    const climbed = held !== undefined && held.reason === "stopped" && held.pressOnly !== true && held.tries > 0;
    const kept: Pick<TurnEnding, "held" | "retries"> = {
        ...opt("held", held === undefined ? undefined : heldSaid(held)),
        ...opt("retries", climbed ? { made: held.tries, max: RETRY_LADDER_TRIES } : undefined),
    };
    if (reason !== "limit") {
        return { reason, ...kept };
    }
    const rerun = card.next?.kind === "rerun" ? card.next : undefined;
    return {
        reason,
        ...opt("resetsAt", card.limitResetsAt),
        ...kept,
        ...opt("scheduled", rerun === undefined ? undefined : true),
        ...opt("nextAt", rerun !== undefined && rerun.at > now ? Math.ceil(rerun.at / 1000) : undefined),
    };
};

const INPUT = { conversationId: "c1", prompt: "Fix the parser" };
// SAFETY: `over` names only the keys its own wall's hold carries, which each fixture below does by hand: a limit's reopen
// and move, a stop's press-only mark, a flagged turn's fork point.
const record = (reason: HeldReason, over: Partial<HeldRecord> = {}): HeldRecord =>
    ({ input: INPUT, reason, ran: true, recordedAt: NOW - 60_000, fired: false, tries: 0, ...over }) as HeldRecord;

// Every way a conversation's actor can hold its last turn: none, each wall's, a stop held for a press alone, a stop whose
// ladder climbed, one the pass already fired, and what each way on costs.
const HOLDS: ReadonlyMap<string, HeldRecord | undefined> = new Map([
    ["none", undefined],
    ["limit", record("limit", { reopensAt: RESET, contextTokens: 40_000, handoffTokens: 2_000 })],
    ["limit, no reset", record("limit", { ran: false })],
    ["limit, moving", record("limit", { reopensAt: RESET, move: { account: "acct-2", carry: true } })],
    ["limit, fired", record("limit", { reopensAt: RESET, fired: true })],
    ["stopped", record("stopped", { contextTokens: 9_000 })],
    ["stopped, climbed", record("stopped", { tries: 2 })],
    ["stopped, press only", record("stopped", { pressOnly: true, tries: 2 })],
    ["stopped, fired", record("stopped", { fired: true, tries: 1 })],
    ["flagged", record("flagged", { resumeAt: "entry-before-stop" })],
    ["door", record("door", { ran: false })],
    ["outage", record("outage")],
    ["auth", record("auth")],
    ["overflow", record("overflow")],
]);

const NEXTS: ReadonlyMap<string, AgentNext | undefined> = new Map([
    ["nothing", undefined],
    ["rerun ahead", { kind: "rerun", at: NOW + 90_000 }],
    ["rerun due", { kind: "rerun", at: NOW - 1_000 }],
    ["rerun, moving", { kind: "rerun", at: NOW, onto: "acct-2" }],
    ["room", { kind: "room" }],
    ["send", { kind: "send", at: NOW + 60_000, count: 1 }],
]);

const CODES: readonly (string | undefined)[] = [undefined, ...Object.keys(FAILURE_CODES), "a-code-from-a-newer-sandbox"];

interface ProjectionCase {
    readonly name: string;
    readonly card: EndingFacts;
    readonly held: HeldRecord | undefined;
}

// Every card a press is read off: each status, each code (none, every one the wire names, one this build does not know),
// with and without a reset, under every booking, beside every hold.
const projectionCases = (): readonly ProjectionCase[] => {
    const cards: { readonly name: string; readonly card: EndingFacts }[] = [];
    for (const status of AgentStatusSchema.options) {
        for (const failureCode of CODES) {
            for (const limitResetsAt of [undefined, RESET]) {
                cards.push(
                    ...[...NEXTS].map(([nextName, next]) => ({
                        name: `${status} / ${failureCode ?? "no code"} / reset ${limitResetsAt ?? "none"} / ${nextName}`,
                        card: { status, ...opt("failureCode", failureCode), ...opt("limitResetsAt", limitResetsAt), ...opt("next", next) },
                    })),
                );
            }
        }
    }
    return cards.flatMap(({ name, card }) => [...HOLDS].map(([holdName, held]) => ({ name: `${name} / held ${holdName}`, card, held })));
};

// The named cases the spec is about, spelled out: [what, the card, the hold beside it, the ending a press carries on].
const NAMED: readonly (readonly [string, EndingFacts, string, TurnEnding])[] = [
    ["a person's Stop", { status: "stopped" }, "stopped", { reason: "stopped" }],
    ["a daemon killed under the turn", { status: "interrupted" }, "stopped", { reason: "stopped" }],
    ["a death nothing coded", { status: "error" }, "stopped", { reason: "stopped", held: { ran: true, contextTokens: 9_000 } }],
    ["a ladder that climbed", { status: "error" }, "stopped, climbed", { reason: "stopped", held: { ran: true }, retries: { made: 2, max: RETRY_LADDER_TRIES } }],
    ["a turn at its own ceiling", { status: "error", failureCode: "turn-cap" }, "stopped, press only", { reason: "stopped", held: { ran: true, pressOnly: true } }],
    ["an outage", { status: "error", failureCode: "provider-outage" }, "outage", { reason: "outage" }],
    ["a flagged turn", { status: "error", failureCode: "safeguard-flagged" }, "flagged", { reason: "flagged", held: { ran: true } }],
    [
        "a spent allowance booked to go again",
        { status: "error", failureCode: "rate_limit", limitResetsAt: RESET, next: { kind: "rerun", at: NOW + 90_000 } },
        "limit",
        { reason: "limit", resetsAt: RESET, held: { ran: true, contextTokens: 40_000, handoffTokens: 2_000 }, scheduled: true, nextAt: NOW / 1000 + 90 },
    ],
    ["a spent allowance with no reset, held", { status: "error", failureCode: "rate_limit" }, "limit, no reset", { reason: "limit", held: { ran: false } }],
    ["a spent allowance nothing holds", { status: "error", failureCode: "rate_limit", limitResetsAt: RESET }, "none", { reason: "limit", resetsAt: RESET }],
    [
        "a spent allowance moving",
        { status: "error", failureCode: "rate_limit", next: { kind: "rerun", at: NOW, onto: "acct-2" } },
        "limit, moving",
        { reason: "limit", held: { ran: true, moving: "acct-2" }, scheduled: true },
    ],
];

describe("the press, read off the card and the turn the actor holds", () => {
    const cases = projectionCases();

    test("states the spec's ending in every case, and nothing to press where it has none", () => {
        const wrong = cases.flatMap(({ name, card, held }) => {
            const expected = spec(card, held, NOW);
            const press: AgentPress = pressOf(card, held, NOW);
            const said = press.kind === "continue" ? press.ending : undefined;
            const agrees = JSON.stringify(said) === JSON.stringify(expected) && JSON.stringify(turnEndingOf(card, held, NOW)) === JSON.stringify(expected);
            return agrees ? [] : [`${name}: ${JSON.stringify(said)} != ${JSON.stringify(expected)}`];
        });
        expect(wrong).toEqual([]);
        // Read over every status, every code and course, and every hold; each case is its own.
        expect(cases.length).toBe(AgentStatusSchema.options.length * CODES.length * 2 * NEXTS.size * HOLDS.size);
    });

    test("says none, never nothing, for every card with nothing to press", () => {
        for (const status of AgentStatusSchema.options.filter((each) => !["stopped", "interrupted", "error"].includes(each))) {
            expect(pressOf({ status }, record("limit", { reopensAt: RESET }), NOW)).toEqual({ kind: "none" });
        }
        expect(pressOf({ status: "error", failureCode: "agent-busy" }, undefined, NOW)).toEqual({ kind: "none" });
    });

    test.each(NAMED)("continues %s", (_name, card, hold, ending) => {
        expect(pressOf(card, HOLDS.get(hold), NOW)).toEqual({ kind: "continue", ending });
    });

    // 2026-11-01, true-pine-bgzz: the card in Finished, the composer still saying "Limit reached, work kept". A card whose
    // turn finished has nothing to press, whatever an earlier refusal left on the actor.
    test("offers nothing on a card whose last turn finished, whatever an earlier refusal left held", () => {
        for (const status of ["idle", "ready", "landed"] as const) {
            expect(pressOf({ status, failureCode: "rate_limit" }, HOLDS.get("limit"), NOW)).toEqual({ kind: "none" });
        }
    });
});

/* THROUGH THE FLEET: every stored ending × every held turn × the conversation's answer to the limit, as the registry
   projects the card and the transcript route states the record. The card always carries `press` (`none` said), and the
   record's ending is the card's press, whatever the case. */

const STORED: ReadonlyMap<string, Ending> = new Map<string, Ending>([
    ["idle", { kind: "idle" }],
    ["stopped", { kind: "stopped" }],
    ["interrupted", { kind: "interrupted" }],
    ["failed, no code", { kind: "failed", failure: "the CLI died" }],
    ...Object.keys(FAILURE_CODES)
        .filter((code) => code !== "rate_limit")
        .map((code): [string, Ending] => [`failed, ${code}`, { kind: "failed", failure: "it failed", code }]),
    ["limited, held", { kind: "limited", failure: "spent", resetsAt: RESET, held: true }],
    ["limited, unheld", { kind: "limited", failure: "spent", resetsAt: RESET, held: false }],
    ["limited, no reset", { kind: "limited", failure: "spent", held: true }],
]);

const ANSWERS = ["wait", "resend"] as const;

const idOf = (stored: string, hold: string, answer: string): string => `${stored}|${hold}|${answer}`.replaceAll(/[^a-z0-9|-]/gu, "-");

// One fleet holding every case, each conversation's hold put back on its actor as a restart's boot puts it.
const everyCase = async () => {
    const entries: PersistedAgent[] = [];
    const holds = new Map<string, HeldRecord>();
    for (const [stored, ending] of STORED) {
        for (const [hold, held] of HOLDS) {
            for (const answer of ANSWERS) {
                const id = idOf(stored, hold, answer);
                entries.push(conversationEntry({ id, ending, postures: { limit: answer }, createdAt: 1_000, updatedAt: 1_000 }));
                if (held !== undefined) {
                    holds.set(id, { ...held, input: { ...held.input, conversationId: id } });
                }
            }
        }
    }
    const store = fleetStoreOver(openConversationsDb(IN_MEMORY));
    store.agents.save(entries);
    const fleet = memoryFleet(store);
    await fleet.agents.init();
    for (const [id, held] of holds) {
        fleet.conversations.send(id, { kind: "hold-restored", held });
    }
    return { fleet, ids: entries.map((entry) => entry.id), holds };
};

// 2026-11-05: a failure nothing coded, back the same with nothing run, was carried on by every press of Continue. From
// the second time the card offers no press: the chat offers the ways out instead.
test("a failure that came back the same with nothing run offers no press", () => {
    const card: EndingFacts = { status: "error", failureRepeats: 2 };
    expect(turnEndingOf(card, undefined, NOW)).toBeUndefined();
    expect(pressOf(card, undefined, NOW).kind).not.toBe("continue");
    // Once, it is still a turn that stopped short, carried on by a press.
    expect(turnEndingOf({ status: "error" }, undefined, NOW)).toEqual({ reason: "stopped" });
});

describe("the card's press and the record's ending, through the fleet", () => {
    test("say the same thing in every case, and the card always says it", async () => {
        const { fleet, ids, holds } = await everyCase();
        const wrong = ids.flatMap((id) => {
            const card = fleet.agents.get(id);
            const press = card?.press;
            if (card === undefined || press === undefined) {
                return [`${id}: no press on the card`];
            }
            const said = press.kind === "continue" ? press.ending : undefined;
            const route = endingOf(fleet, id);
            const expected = spec(card, holds.get(id), Date.now());
            const problems = [
                ...(JSON.stringify(route) === JSON.stringify(said) ? [] : [`route ${JSON.stringify(route)} != card ${JSON.stringify(said)}`]),
                ...(JSON.stringify(said) === JSON.stringify(expected) ? [] : [`card ${JSON.stringify(said)} != spec ${JSON.stringify(expected)}`]),
            ];
            return problems.map((problem) => `${id}: ${problem}`);
        });
        expect(wrong).toEqual([]);
        expect(ids.length).toBe(STORED.size * HOLDS.size * ANSWERS.length);
    });

    test("projects each stored ending to the press it stands for", async () => {
        const { fleet } = await everyCase();
        const pressOn = (stored: string, hold: string, answer: string = "wait"): AgentSummary["press"] => fleet.agents.get(idOf(stored, hold, answer))?.press;
        expect(pressOn("idle", "limit")).toEqual({ kind: "none" });
        expect(pressOn("stopped", "stopped")).toEqual({ kind: "continue", ending: { reason: "stopped" } });
        expect(pressOn("interrupted", "none")).toEqual({ kind: "continue", ending: { reason: "stopped" } });
        expect(pressOn("failed, no code", "stopped")).toEqual({ kind: "continue", ending: { reason: "stopped", held: { ran: true, contextTokens: 9_000 } } });
        expect(pressOn("failed, turn-cap", "stopped, press only")).toEqual({ kind: "continue", ending: { reason: "stopped", held: { ran: true, pressOnly: true } } });
        expect(pressOn("failed, agent-busy", "none")).toEqual({ kind: "none" });
        expect(pressOn("failed, provider-outage", "outage")).toEqual({ kind: "continue", ending: { reason: "outage" } });
        expect(pressOn("failed, safeguard-flagged", "flagged")).toEqual({ kind: "continue", ending: { reason: "flagged", held: { ran: true } } });
        expect(pressOn("limited, unheld", "none")).toEqual({ kind: "continue", ending: { reason: "limit", resetsAt: RESET } });
        // Booked by the conversation's answer: the card's `next` is the hold's reopen, which the ending states.
        const booked = fleet.agents.get(idOf("limited, held", "limit", "resend"));
        expect(booked?.next).toEqual({ kind: "rerun", at: sendableAt(booked?.limitResetsAt ?? 0) });
        expect(booked?.press).toEqual({
            kind: "continue",
            ending: {
                reason: "limit",
                resetsAt: booked?.limitResetsAt,
                held: { ran: true, contextTokens: 40_000, handoffTokens: 2_000 },
                scheduled: true,
                nextAt: Math.ceil(sendableAt(booked?.limitResetsAt ?? 0) / 1000),
            },
        });
        // Fired, the hold books nothing more: the press re-runs it, said without a booking.
        expect(pressOn("limited, held", "limit, fired", "resend")).toMatchObject({ kind: "continue", ending: { reason: "limit", held: { ran: true } } });
        expect(pressOn("limited, held", "limit, fired", "resend")).not.toMatchObject({ ending: { scheduled: true } });
    });

    // A land runs beside the turn's ending: while its lease shows, the card reads `landing`, and the press is still what the
    // turn left, or every window's strip would go for the length of the land and come back after it.
    test("keeps the press through a land, and says the same once the land lets go", async () => {
        const { fleet } = await everyCase();
        for (const [stored, hold] of [
            ["stopped", "stopped"],
            ["limited, held", "limit"],
            ["failed, turn-cap", "stopped, press only"],
            ["idle", "none"],
        ] as const) {
            const id = idOf(stored, hold, "wait");
            const before = fleet.agents.get(id)?.press;
            fleet.conversations.send(id, { kind: "land-leased" });
            expect([stored, fleet.agents.get(id)?.status, fleet.agents.get(id)?.press]).toEqual([stored, "landing", before]);
            fleet.conversations.send(id, { kind: "land-released" });
            expect([stored, fleet.agents.get(id)?.press]).toEqual([stored, before]);
        }
    });

    test("offers nothing while a turn runs, whatever its last one left", async () => {
        const { fleet } = await everyCase();
        const id = idOf("limited, held", "limit", "resend");
        await beginTurn(fleet.conversations, { conversationId: id, isolated: false, prompt: "go on", profile: { agent: "claude", harness: "native" } }, Date.now());
        expect(fleet.agents.get(id)).toMatchObject({ status: "running", press: { kind: "none" } });
        expect(endingOf(fleet, id)).toBeUndefined();
    });
});

/* EVERY CHANGE TO THE HELD TURN REACHES EVERY WINDOW. The card's `press`, like its `next`, is derived from the hold each
   time the card is projected, so what carries it out is a broadcast after each change: one the change makes itself (a
   re-timed or walled hold, a hand-off pick, a fire, a drop, a hold restored) or the settle or begin it rides with (a
   refusal held, a turn superseding the hold). A change no send followed would leave every window's strip on the old
   press until something unrelated moved the card. */

describe("a held turn's every change", () => {
    const PROFILE = { agent: "claude", harness: "native" } as const;
    const input = { conversationId: "c1", prompt: "Fix the parser" };

    // The roster as each send carried it: c1's press, in order.
    const watching = (fleet: Fleet) => {
        const sent: (AgentPress | undefined)[] = [];
        fleet.agents.subscribe((agents) => sent.push(agents.find((agent) => agent.id === "c1")?.press));
        return {
            // Something went out since the last look, and its last word is the card's press now.
            sentSince: (from: number) => ({ count: sent.length - from, last: sent.at(-1), now: fleet.agents.get("c1")?.press }),
            mark: () => sent.length,
        };
    };

    test("is published with the press it leaves", async () => {
        const fleet = memoryFleet();
        await fleet.agents.init();
        const roster = watching(fleet);
        // A change, and every effect it named run (a settle's broadcast follows its write).
        const published = async (change: () => Promise<void> | void): Promise<{ count: number; last: AgentPress | undefined; now: AgentPress | undefined }> => {
            const from = roster.mark();
            await change();
            return roster.sentSince(from);
        };
        const told = async (event: Parameters<typeof fleet.conversations.send>[1], now?: number): Promise<void> => {
            await fleet.conversations.send("c1", event, now).settled;
        };
        const agrees = (sent: { count: number; last: AgentPress | undefined; now: AgentPress | undefined }): void => {
            expect(sent.count).toBeGreaterThan(0);
            expect(sent.last).toEqual(sent.now);
            expect(endingOf(fleet, "c1")).toEqual(sent.now?.kind === "continue" ? sent.now.ending : undefined);
        };

        // A spent allowance refused with no instant, held: the refusal's settle publishes it.
        await beginTurn(fleet.conversations, { conversationId: "c1", isolated: true, prompt: "Fix the parser", profile: PROFILE }, 1_000);
        fleet.conversations.send("c1", { kind: "frame", frame: { kind: "error", code: "rate_limit", message: "spent", autoResume: "available", held: { ran: true } } });
        fleet.conversations.send("c1", { kind: "turn-held", held: { input, reason: "limit", ran: true } }, 1_500);
        let sent = await published(() => told({ kind: "settle" }, 2_000));
        agrees(sent);
        expect(sent.now).toEqual({ kind: "continue", ending: { reason: "limit", held: { ran: true } } });

        // The pass learns its reopen.
        const reopensAt = Math.ceil(Date.now() / 1000) + 3_600;
        sent = await published(() => told({ kind: "held-retimed", reopensAt }));
        agrees(sent);
        expect(sent.now).toMatchObject({ ending: { resetsAt: reopensAt } });

        // The conversation's answer books it: the policy write publishes the booking.
        sent = await published(async () => {
            await fleet.agents.setBreakPolicy("c1", "limit", "resend");
        });
        agrees(sent);
        expect(sent.now).toMatchObject({ ending: { scheduled: true, nextAt: Math.ceil(sendableAt(reopensAt) / 1000) } });

        // The pass reads a wall in front of where it goes: the booking moves behind it.
        const wall = sendableAt(reopensAt) + 3_600_000;
        sent = await published(() => told({ kind: "held-walled", until: wall }));
        agrees(sent);
        expect(sent.now).toMatchObject({ ending: { nextAt: Math.ceil(wall / 1000) } });

        // Its one dispatch: nothing is booked any more, and every window hears so before the re-run begins, if it ever does.
        const judged = fleet.conversations.state("c1")?.resume.held;
        if (judged === undefined) {
            throw new Error("expected a hold");
        }
        sent = await published(() => told({ kind: "held-fired", ladder: false, judged }));
        agrees(sent);
        expect(sent.now).toEqual({ kind: "continue", ending: { reason: "limit", resetsAt: reopensAt, held: { ran: true } } });

        // A cancel drops it: nothing held, and the reopen the pass found went with the hold (the refusal named none).
        sent = await published(() => told({ kind: "resume-dropped" }));
        agrees(sent);
        expect(sent.now).toEqual({ kind: "continue", ending: { reason: "limit" } });

        // A boot puts a hold back.
        sent = await published(() => told({ kind: "hold-restored", held: { input, reason: "limit", ran: false, recordedAt: Date.now(), fired: false, tries: 0 } }));
        agrees(sent);
        expect(sent.now).toMatchObject({ ending: { held: { ran: false } } });

        // A turn takes the hold's place: its begin publishes that nothing is left to press.
        sent = await published(async () => {
            await beginTurn(fleet.conversations, { conversationId: "c1", isolated: true, prompt: "go on", profile: PROFILE }, Date.now());
            await told({ kind: "resume-superseded" });
        });
        expect(sent.count).toBeGreaterThan(0);
        expect(fleet.agents.get("c1")?.press).toEqual({ kind: "none" });

        // It reaches its own ceiling: held for a press alone, which the settle publishes.
        fleet.conversations.send("c1", { kind: "frame", frame: { kind: "error", code: "turn-cap", message: "Reached the maximum number of turns.", autoResume: "available", held: { ran: true, pressOnly: true } } });
        fleet.conversations.send("c1", { kind: "turn-held", held: { input, reason: "stopped", ran: true, pressOnly: true } });
        sent = await published(() => told({ kind: "settle" }));
        agrees(sent);
        expect(sent.now).toEqual({ kind: "continue", ending: { reason: "stopped", held: { ran: true, pressOnly: true } } });
    });
});
