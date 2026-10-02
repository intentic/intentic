import type { AgentNeed, Need, NeedRaise, NeedSubject, NeedTold } from "@intentic/sandbox-contract";
import { memoryNeedsStore } from "../testing.js";
import type { TurnStanding } from "../conversations/actor/turn-standing.js";
import type { Answered, Met, NeedKindHandler, NeedKinds, Resolved } from "./need-kinds.js";
import { createNeeds, type NeedsDeps } from "./needs.js";

// The lifecycle every kind shares, driven through a fake kind: an ask is answered on its call when a person is quick,
// kept when they are not, and its answer reaches the conversation by itself, however the turn stands by then.

const SUBJECT: NeedSubject = { kind: "secret", name: "OPENAI_API_KEY" };
const STANDING: TurnStanding = {
    at: 0,
    unattended: false,
    persona: undefined,
    granted: [],
    withheldByPersona: [],
    withheldByGate: [],
    fence: undefined,
    powers: { files: "write", shell: true, code: true, web: true, browser: true, delegate: true, sandbox: true },
    runtime: "claude-code",
    secrets: "masked",
};

interface FakeKind {
    resolved: Resolved;
    // What check() answers; set it to meet an open need at the next check.
    met: Met | undefined;
    answered: Answered;
    nextTurn: boolean;
    declinedCalls: string[];
}

const fakeKind = (state: FakeKind): NeedKindHandler => ({
    resolve: async () => state.resolved,
    check: async () => state.met,
    answer: async () => state.answered,
    declined: async (need) => {
        state.declinedCalls.push(need.id);
    },
    nextTurn: () => state.nextTurn,
    key: (subject) => JSON.stringify(subject),
});

interface Harness {
    readonly deps: NeedsDeps;
    readonly kind: FakeKind;
    readonly drawn: Need[];
    readonly shown: { conversationId: string; needs: readonly AgentNeed[] }[];
    readonly notified: Need[];
    readonly withdrawn: Need[];
    readonly steered: { conversationId: string; prompt: string }[];
    readonly woken: { conversationId: string; prompt: string }[];
    readonly settings: { continueWhenMet: boolean; live: boolean; steerable: boolean; standing: TurnStanding | undefined };
    readonly endTurn: (conversationId: string) => void;
}

const harness = (): Harness => {
    const kind: FakeKind = {
        resolved: { kind: "raise", subject: SUBJECT, title: "The OPENAI_API_KEY secret" },
        met: undefined,
        answered: { status: "met", result: "Stored under OPENAI_API_KEY.", use: ["Write {{secret:OPENAI_API_KEY}} in a command."] },
        nextTurn: false,
        declinedCalls: [],
    };
    const drawn: Need[] = [];
    const shown: Harness["shown"] = [];
    const notified: Need[] = [];
    const withdrawn: Need[] = [];
    const steered: Harness["steered"] = [];
    const woken: Harness["woken"] = [];
    const settings: Harness["settings"] = { continueWhenMet: true, live: true, steerable: true, standing: STANDING };
    const ended = new Set<(conversationId: string) => void>();
    const handler = fakeKind(kind);
    const kinds: NeedKinds = { capability: handler, secret: handler, grant: handler, release: handler, environment: handler };
    let next = 0;
    const deps: NeedsDeps = {
        store: memoryNeedsStore(),
        kinds,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        raisingConversation: (named) => named ?? "conv-sole",
        standingOf: () => settings.standing,
        isLive: () => settings.live,
        draw: (_conversationId, need) => drawn.push(need),
        show: (conversationId, needs) => shown.push({ conversationId, needs }),
        notify: (need) => notified.push(need),
        withdrawNotification: (need) => withdrawn.push(need),
        steer: async (conversationId, prompt) => {
            if (!settings.steerable) {
                return false;
            }
            steered.push({ conversationId, prompt });
            return true;
        },
        wake: async (conversationId, prompt): Promise<NeedTold> => {
            woken.push({ conversationId, prompt });
            return settings.live ? "turn" : "queued";
        },
        continueWhenMet: async () => settings.continueWhenMet,
        provideSecret: async (need) => ({ result: `${need.title} is stored.`, use: [] }),
        onTurnEnded: (listener) => {
            ended.add(listener);
            return () => ended.delete(listener);
        },
        pollMs: 60_000,
        newId: () => `need-${(next += 1)}`,
    };
    return {
        deps,
        kind,
        drawn,
        shown,
        notified,
        withdrawn,
        steered,
        woken,
        settings,
        endTurn: (conversationId) => {
            for (const listener of ended) {
                listener(conversationId);
            }
        },
    };
};

const raise = (wait = 0): NeedRaise => ({ ask: { kind: "secret", name: "OPENAI_API_KEY" }, why: "to call the model in the eval script", wait });
const signal = (): AbortSignal => new AbortController().signal;
const settleSoon = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe("needs", () => {
    it("answers at once, raising nothing, when the kind says it is already usable", async () => {
        const { deps, kind, drawn } = harness();
        kind.resolved = { kind: "met", message: "OPENAI_API_KEY is stored: write {{secret:OPENAI_API_KEY}}." };
        const needs = createNeeds(deps);
        const answer = await needs.ask({ raise: raise(), conversationId: "conv-1", signal: signal() });
        expect(answer).toEqual({ state: "met", message: "OPENAI_API_KEY is stored: write {{secret:OPENAI_API_KEY}}." });
        expect(drawn).toEqual([]);
        expect(await deps.store.all()).toEqual([]);
    });

    it("refuses with the kind's sentence and raises nothing", async () => {
        const { deps, kind } = harness();
        kind.resolved = { kind: "refused", code: "unknown_capability", message: "No catalog entry is named notion." };
        const answer = await createNeeds(deps).ask({ raise: raise(), conversationId: "conv-1", signal: signal() });
        expect(answer).toEqual({ state: "refused", code: "unknown_capability", message: "No catalog entry is named notion." });
    });

    it("refuses when no conversation can be found to ask in", async () => {
        const { deps } = harness();
        const needs = createNeeds({ ...deps, raisingConversation: () => undefined });
        const answer = await needs.ask({ raise: raise(), conversationId: undefined, signal: signal() });
        expect(answer.state).toBe("refused");
        expect(answer.code).toBe("no_conversation");
    });

    it("keeps an unanswered ask open, draws its card, shows it on the board and tells the devices", async () => {
        const { deps, drawn, shown, notified } = harness();
        const answer = await createNeeds(deps).ask({ raise: raise(0), conversationId: "conv-1", signal: signal() });
        expect(answer.state).toBe("open");
        expect(answer.message).toContain("need need-1");
        expect(answer.message).toContain("do not poll and do not ask again");
        expect(drawn.map((need) => need.id)).toEqual(["need-1"]);
        expect(notified.map((need) => need.id)).toEqual(["need-1"]);
        expect(shown.at(-1)).toEqual({
            conversationId: "conv-1",
            needs: [{ id: "need-1", kind: "secret", title: "The OPENAI_API_KEY secret", status: "open" }],
        });
        expect(answer.need).toMatchObject({ status: "open", why: "to call the model in the eval script", conversationId: "conv-1" });
    });

    it("answers on the call when a person is quick, and wakes nothing", async () => {
        const { deps, woken, steered } = harness();
        const needs = createNeeds(deps);
        const asking = needs.ask({ raise: raise(30), conversationId: "conv-1", signal: signal() });
        await settleSoon();
        await needs.answer("need-1", { kind: "approve" }, { email: "owner@example.com" });
        const answer = await asking;
        expect(answer.state).toBe("met");
        expect(answer.message).toBe("Stored under OPENAI_API_KEY. Write {{secret:OPENAI_API_KEY}} in a command.");
        expect(woken).toEqual([]);
        expect(steered).toEqual([]);
        expect(await deps.store.get("need-1")).toMatchObject({ status: "met", told: "call", answeredBy: "owner@example.com" });
    });

    it("wakes the conversation with the outcome when the answer comes after the call let go", async () => {
        const { deps, woken, shown } = harness();
        const needs = createNeeds(deps);
        await needs.ask({ raise: raise(0), conversationId: "conv-1", signal: signal() });
        await needs.answer("need-1", { kind: "approve" }, { email: "owner@example.com" });
        expect(woken).toHaveLength(1);
        expect(woken[0]?.conversationId).toBe("conv-1");
        expect(woken[0]?.prompt).toContain("Need met: a person gave you what you asked for.");
        expect(woken[0]?.prompt).toContain("Need id: need-1");
        expect(woken[0]?.prompt).toContain("Write {{secret:OPENAI_API_KEY}} in a command.");
        expect(await deps.store.get("need-1")).toMatchObject({ status: "met", told: "turn" });
        expect(shown.at(-1)).toEqual({ conversationId: "conv-1", needs: [] });
    });

    it("leaves a met need on the card, not in a new turn, when the owner turned continuing off", async () => {
        const { deps, woken, settings } = harness();
        settings.continueWhenMet = false;
        const needs = createNeeds(deps);
        await needs.ask({ raise: raise(0), conversationId: "conv-1", signal: signal() });
        await needs.answer("need-1", { kind: "approve" }, { email: undefined });
        expect(woken).toEqual([]);
        expect((await deps.store.get("need-1"))?.told).toBeUndefined();
    });

    it("tells a live turn about a decline, and wakes a finished conversation for nothing", async () => {
        const { deps, steered, woken, settings, kind } = harness();
        const needs = createNeeds(deps);
        await needs.ask({ raise: raise(0), conversationId: "conv-1", signal: signal() });
        await needs.answer("need-1", { kind: "decline", note: "use the staging key instead" }, { email: "owner@example.com" });
        expect(steered[0]?.prompt).toContain("Need declined");
        expect(steered[0]?.prompt).toContain("They said: use the staging key instead");
        expect(kind.declinedCalls).toEqual(["need-1"]);
        settings.steerable = false;
        kind.resolved = { kind: "raise", subject: { kind: "secret", name: "OTHER_KEY" }, title: "The OTHER_KEY secret" };
        await needs.ask({ raise: { ...raise(0), ask: { kind: "secret", name: "OTHER_KEY" } }, conversationId: "conv-1", signal: signal() });
        await needs.answer("need-2", { kind: "decline" }, { email: undefined });
        expect(woken).toEqual([]);
        expect((await deps.store.get("need-2"))?.told).toBeUndefined();
    });

    it("finds the first need when the same thing is asked again, rather than raising a second", async () => {
        const { deps, drawn } = harness();
        const needs = createNeeds(deps);
        await needs.ask({ raise: raise(0), conversationId: "conv-1", signal: signal() });
        const again = await needs.ask({ raise: raise(0), conversationId: "conv-1", signal: signal() });
        expect(again.need?.id).toBe("need-1");
        expect(drawn).toHaveLength(1);
    });

    it("holds every call waiting on one need, and answers them all when it settles", async () => {
        const { deps } = harness();
        const needs = createNeeds(deps);
        const first = needs.ask({ raise: raise(30), conversationId: "conv-1", signal: signal() });
        await settleSoon();
        const second = needs.ask({ raise: raise(30), conversationId: "conv-1", signal: signal() });
        await settleSoon();
        await needs.answer("need-1", { kind: "approve" }, { email: undefined });
        expect((await first).state).toBe("met");
        expect((await second).state).toBe("met");
    });

    it("answers a declined ask with the decline, not a fresh card", async () => {
        const { deps, drawn } = harness();
        const needs = createNeeds(deps);
        await needs.ask({ raise: raise(0), conversationId: "conv-1", signal: signal() });
        await needs.answer("need-1", { kind: "decline" }, { email: undefined });
        const again = await needs.ask({ raise: raise(0), conversationId: "conv-1", signal: signal() });
        expect(again).toMatchObject({ state: "refused", code: "declined" });
        expect(again.message).toContain("do not ask for it again in this conversation");
        expect(drawn).toHaveLength(1);
    });

    it("never holds an unattended turn's call, since nobody answers while it runs", async () => {
        const { deps, settings } = harness();
        settings.standing = { ...STANDING, unattended: true };
        const started = Date.now();
        const answer = await createNeeds(deps).ask({ raise: raise(60), conversationId: "conv-1", signal: signal() });
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(answer.state).toBe("open");
        expect(answer.message).toContain("This turn is unattended");
        expect(answer.need?.unattended).toBe(true);
    });

    it("lets a call go when its shell goes away, and keeps the need", async () => {
        const { deps } = harness();
        const controller = new AbortController();
        const asking = createNeeds(deps).ask({ raise: raise(60), conversationId: "conv-1", signal: controller.signal });
        await settleSoon();
        controller.abort();
        expect((await asking).state).toBe("open");
        expect((await deps.store.get("need-1"))?.status).toBe("open");
    });

    it("continues a conversation once its turn ends, for a need that only mounts on a next turn", async () => {
        const { deps, woken, kind, endTurn, settings } = harness();
        kind.nextTurn = true;
        const needs = createNeeds(deps);
        const stop = needs.start();
        await needs.ask({ raise: raise(0), conversationId: "conv-1", signal: signal() });
        await needs.answer("need-1", { kind: "grant", scope: "conversation" }, { email: undefined });
        expect(woken).toEqual([]);
        settings.live = false;
        endTurn("conv-1");
        await settleSoon();
        expect(woken.map((wake) => wake.conversationId)).toEqual(["conv-1"]);
        expect((await deps.store.get("need-1"))?.told).toBe("queued");
        stop();
    });

    it("meets an open need the moment the world does, and says so to a call still holding", async () => {
        const { deps, kind } = harness();
        const needs = createNeeds(deps);
        const asking = needs.ask({ raise: raise(30), conversationId: "conv-1", signal: signal() });
        await settleSoon();
        kind.met = { result: 'GitHub is connected as "github".', use: [] };
        needs.recheck();
        const answer = await asking;
        expect(answer).toMatchObject({ state: "met", message: 'GitHub is connected as "github".' });
    });

    it("moves a need to working on a yes still being carried out, and keeps it open", async () => {
        const { deps, kind, shown } = harness();
        kind.answered = { status: "working" };
        const needs = createNeeds(deps);
        await needs.ask({ raise: raise(0), conversationId: "conv-1", signal: signal() });
        const need = await needs.answer("need-1", { kind: "accept" }, { email: "owner@example.com" });
        expect(need.status).toBe("working");
        expect(shown.at(-1)?.needs.map((entry) => entry.status)).toEqual(["working"]);
    });

    it("refuses an answer the kind will not take, and leaves the need waiting", async () => {
        const { deps, kind } = harness();
        kind.answered = { refused: "Only bob@example.com can release this." };
        const needs = createNeeds(deps);
        await needs.ask({ raise: raise(0), conversationId: "conv-1", signal: signal() });
        await expect(needs.answer("need-1", { kind: "release" }, { email: "eve@example.com" })).rejects.toThrow("Only bob@example.com can release this.");
        expect((await deps.store.get("need-1"))?.status).toBe("open");
    });

    it("withdraws a need without telling anyone, and refuses another conversation's", async () => {
        const { deps, woken, steered } = harness();
        const needs = createNeeds(deps);
        await needs.ask({ raise: raise(0), conversationId: "conv-1", signal: signal() });
        await expect(needs.withdraw("need-1", "conv-2")).rejects.toThrow("raised by another conversation");
        const withdrawn = await needs.withdraw("need-1", "conv-1");
        expect(withdrawn.status).toBe("cancelled");
        expect(woken).toEqual([]);
        expect(steered).toEqual([]);
    });

    it("stores a secret need's value through its kind and meets it, never echoing the value", async () => {
        const { deps, woken } = harness();
        const needs = createNeeds(deps);
        await needs.ask({ raise: raise(0), conversationId: "conv-1", signal: signal() });
        const met = await needs.provide("need-1", "sk-live-value-never-echoed", { email: "owner@example.com" });
        expect(met).toMatchObject({ status: "met", outcome: "The OPENAI_API_KEY secret is stored.", answeredBy: "owner@example.com" });
        expect(JSON.stringify(await deps.store.all())).not.toContain("sk-live-value-never-echoed");
        expect(woken[0]?.prompt).not.toContain("sk-live-value-never-echoed");
    });

    it("says at boot what a restart interrupted: a met need nobody was told of", async () => {
        const { deps, woken, settings } = harness();
        settings.live = false;
        await deps.store.put({
            id: "need-9",
            conversationId: "conv-3",
            subject: SUBJECT,
            title: "The OPENAI_API_KEY secret",
            status: "met",
            outcome: "Stored under OPENAI_API_KEY.",
            createdAt: Date.now() - 2_000,
            updatedAt: Date.now() - 1_000,
        });
        const stop = createNeeds(deps).start();
        await settleSoon();
        expect(woken.map((wake) => wake.conversationId)).toEqual(["conv-3"]);
        expect((await deps.store.get("need-9"))?.told).toBe("queued");
        stop();
    });
});

// Seen rather than asked: the person's own browser's `ask_access` (webext-peer.ts) puts its card up through here.
test("a need the harness saw asked is drawn like any other and never held, and the same ask again is the card already up", async () => {
    const { deps, drawn, shown, notified, kind, woken } = harness();
    const needs = createNeeds(deps);
    const site: NeedSubject = { kind: "grant", subject: "site", what: "github.com", label: "github.com" };
    const first = await needs.observe("conv-web", site, "Allow github.com in your browser", "to read the PR checks");
    expect(first).toEqual({
        id: "need-1",
        conversationId: "conv-web",
        subject: site,
        title: "Allow github.com in your browser",
        why: "to read the PR checks",
        status: "open",
        createdAt: first.createdAt,
        updatedAt: first.createdAt,
    });
    expect(drawn.map((need) => need.id)).toEqual(["need-1"]);
    expect(notified.map((need) => need.id)).toEqual(["need-1"]);
    expect(shown.at(-1)).toEqual({ conversationId: "conv-web", needs: [{ id: "need-1", kind: "grant", title: "Allow github.com in your browser", status: "open" }] });
    expect((await needs.observe("conv-web", site, "Allow github.com in your browser")).id).toBe("need-1");
    expect(drawn).toHaveLength(1);
    // Met by the world (the browser allowed it): the conversation hears it, as for any need nobody's call held.
    kind.met = { result: "github.com is allowed in the person's browser.", use: [] };
    needs.recheck();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await needs.get("need-1"))?.status).toBe("met");
    expect(woken.map((wake) => wake.conversationId)).toEqual(["conv-web"]);
});

test("a need answered is withdrawn from the owner's devices once, as it stops waiting", async () => {
    const { deps, withdrawn } = harness();
    const needs = createNeeds(deps);
    const { state } = await needs.ask({ raise: raise(0), conversationId: "conv-1", signal: signal() });
    expect(state).toBe("open");
    expect(withdrawn).toEqual([]);

    await needs.answer("need-1", { kind: "accept" }, { email: "user@example.com" });
    expect(withdrawn.map((need) => [need.id, need.status])).toEqual([["need-1", "met"]]);
});
