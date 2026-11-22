import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { ParkKind } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { TranscriptFold } from "@intentic/sandbox-contract/transcript-fold";
import { unstubbed } from "@intentic/testing";
import pino from "pino";
import webpush from "web-push";
import type { Services } from "../composition.js";
import { parkedCards, type StandingYes } from "../conversations/actor/parked-cards.js";
import { memoryFleet } from "../conversations/registry/agents-registry.testing.js";
import { conversationEntry } from "../conversations/registry/agents-store.testing.js";
import { raiseRequest } from "../guard/card-offers.js";
import { notifyAwaiting } from "./awaiting-detail.js";
import { awaitingResolved } from "./notifications.js";
import { createPushSender, type PushDelivery } from "./push.js";
import type { PushStore } from "./push-store.js";

/* From a card being raised to a phone buzzing, with every real piece between them: the card registry and what answers a
 * card on its own (a conversation's standing "allow everything"), the gate that raises it, the announcement that reads
 * it off the run, and the sender that pushes it and withdraws it. Only the web-push transport is stubbed.
 *
 * 2026-11-14: a reader who had allowed everything in a conversation was buzzed "Permission needed" for a delete it was
 * already allowed, and found the card frozen as Allowed when they tapped it. The push went out before the standing yes
 * had been read, and its withdrawal, asked while that push was still in flight, found nothing shown to replace, so the
 * ask stayed on the lock screen. */

afterEach(() => jest.restoreAllMocks());

interface Pushed {
    readonly title: string;
    readonly tag: string | undefined;
    readonly silent: boolean;
}

// What each push carried, in order, and whether one is on its way; nothing leaves the process.
const stubSends = () => {
    const reached: Pushed[] = [];
    let flying = 0;
    jest.spyOn(webpush, "setVapidDetails").mockImplementation(() => undefined);
    jest.spyOn(webpush, "sendNotification").mockImplementation(async (_target, payload) => {
        flying += 1;
        // A push service answers over the network: the send settles a moment after it is asked.
        await new Promise((resolve) => setTimeout(resolve, 5));
        // SAFETY: the payload is the JSON push.ts serialised from a PushNotification a line before handing it here.
        const sent = JSON.parse(String(payload)) as { title: string; tag?: string; silent?: boolean };
        reached.push({ title: sent.title, tag: sent.tag, silent: sent.silent === true });
        flying -= 1;
        return { statusCode: 201, body: "", headers: {} };
    });
    return { reached, inFlight: () => flying > 0 };
};

// One phone, registered by the owner's own tool: it hears every card no one in particular took part in.
const phone: PushStore = unstubbed<PushStore>("push", {
    keys: async () => ({ publicKey: "public-key", privateKey: "private-key" }),
    list: async () => [{ kind: "webpush", endpoint: "https://push.example/phone", keys: { p256dh: "p256dh-key", auth: "auth-secret" } }],
});

// A standing yes read from its file, as conversation-grants.ts does: the answer comes back on a later turn of the loop.
const standingFor = (allowed: ReadonlySet<string>): StandingYes => ({
    allowed: async (conversationId, hardRule) => {
        await new Promise((resolve) => setImmediate(resolve));
        return !hardRule && allowed.has(conversationId);
    },
    allow: async () => undefined,
    failed: () => undefined,
});

const TITLE = { text: "Clean the build caches", source: "derived" } as const;

// The daemon's reactions, wired as composition wires them: a card that parks is announced (wireReactions), one that
// stops waiting is withdrawn (conversations-slice.ts `cardSettled`).
const wired = (allowed: ReadonlySet<string>) => {
    const { reached, inFlight } = stubSends();
    const pushSender = createPushSender(phone, pino({ level: "silent" }), async () => ({ callerOf: () => undefined }));
    const withdrawals: Promise<PushDelivery>[] = [];
    const cards = parkedCards(memoryFleet().conversations, standingFor(allowed), (requestId, conversationId) => {
        if (conversationId !== undefined) {
            withdrawals.push(pushSender.withdraw(awaitingResolved(conversationId, `awaiting-${requestId}`)));
        }
    });
    const fold = new TranscriptFold([]);
    const run = { conversationId: "conv-1", push: (event: AgentEvent) => void fold.apply(event) };
    const services: Pick<Services, "agents" | "pushSender" | "cards"> = {
        agents: unstubbed<Services["agents"]>("agents", {
            entry: (id) => (id === "conv-1" ? conversationEntry({ id, social: { title: TITLE, reactions: [] } }) : undefined),
        }),
        pushSender,
        cards,
    };
    const announced: Promise<PushDelivery>[] = [];
    // The announcement composition makes of `turn.awaiting`, whoever published it.
    const announce = (kind: ParkKind, requestId: string): void =>
        void announced.push(notifyAwaiting(services, { conversationId: "conv-1", kind, requestId, run: { rows: fold.rows } }));
    const deps = {
        observe: () => undefined,
        cards,
        awaiting: (_conversationId: string, kind: ParkKind, requestId: string) => announce(kind, requestId),
    };
    // Every announcement and withdrawal this test started, settled.
    const settle = async (): Promise<{ readonly announced: readonly PushDelivery[]; readonly withdrawn: readonly PushDelivery[] }> => ({
        announced: await Promise.all(announced),
        withdrawn: await Promise.all(withdrawals),
    });
    // The permission card the run holds, by its request id.
    const raisedId = (): string => fold.rows.findLast((row) => row.permission !== undefined)?.permission?.requestId ?? "";
    return { reached, inFlight, cards, run, deps, announce, settle, raisedId };
};

const deleteCard = {
    kind: "permission" as const,
    onAbort: { kind: "permission" as const, requestId: "", decision: "deny" as const },
    raised: (requestId: string): AgentEvent => ({ kind: "permission", requestId, toolName: "Bash", title: "This command would delete files" }),
    approves: (reply: { readonly decision: string }) => reply.decision !== "deny",
};

// Turns the loop until `done` holds, so a step lands where the test means it to: bounded, so a wrong guess fails rather
// than hangs.
const until = async (done: () => boolean): Promise<void> => {
    for (let turn = 0; turn < 200 && !done(); turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    expect(done()).toBe(true);
};

test("a card the conversation's standing yes answers is never pushed, and nothing is left on the lock screen", async () => {
    const { reached, run, deps, settle } = wired(new Set(["conv-1"]));

    const answered = await raiseRequest(deps, run, deleteCard);
    const { announced } = await settle();

    expect(answered.reply.decision).toBe("everything");
    expect(reached).toEqual([]);
    expect(announced).toEqual([{ delivered: 0, failed: 0, skipped: "answered before anyone was told" }]);
});

// The Claude Code loop's permission gate (and every runtime's like it) mints the card and pushes its frame, which the
// turn's pump announces before folding it (agent/run/turn/turn-runs.ts), and waits on the card only once the pump asks
// for more: the announcement can come before anything waits on the card at all.
test("a card the turn raised itself is decided as it is raised, so its announcement never outruns the standing yes", async () => {
    const { reached, cards, run, announce, settle } = wired(new Set(["conv-1"]));

    const { id, wait } = cards.create("permission", deleteCard.onAbort, "conv-1");
    announce("permission", id);
    run.push(deleteCard.raised(id));
    const { announced } = await settle();

    expect(announced).toEqual([{ delivered: 0, failed: 0, skipped: "answered before anyone was told" }]);
    expect((await wait(new AbortController().signal)).reply.decision).toBe("everything");
    expect(reached).toEqual([]);
});

test("a card nothing answers on its own is pushed once with its words, and replaced silently once a person answers", async () => {
    const { reached, cards, run, deps, settle, raisedId } = wired(new Set());

    const answering = raiseRequest(deps, run, deleteCard);
    await settle();
    expect(reached).toEqual([{ title: "Clean the build caches: permission needed", tag: `awaiting-${raisedId()}`, silent: false }]);

    expect(cards.resolve({ kind: "permission", requestId: raisedId(), decision: "once" })).toBe("settled");
    await answering;
    await settle();
    expect(reached.slice(1)).toEqual([{ title: "No longer waiting", tag: `awaiting-${raisedId()}`, silent: true }]);
});

test("a card answered while its push is still on its way is replaced once that push lands, never left standing", async () => {
    const { reached, inFlight, cards, run, deps, settle, raisedId } = wired(new Set());

    const answering = raiseRequest(deps, run, deleteCard);
    await until(inFlight);
    expect(cards.resolve({ kind: "permission", requestId: raisedId(), decision: "once" })).toBe("settled");
    await answering;
    const { withdrawn } = await settle();

    expect(reached.map(({ title, silent }) => [title, silent])).toEqual([
        ["Clean the build caches: permission needed", false],
        ["No longer waiting", true],
    ]);
    expect(withdrawn).toEqual([{ delivered: 1, failed: 0 }]);
});
