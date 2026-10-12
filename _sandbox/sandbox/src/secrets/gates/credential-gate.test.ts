import type { AgentEvent, CredentialGate as GatePolicy } from "@intentic/sandbox-contract";
import { createCredentialGate, type CredentialCheck, type CredentialGateDeps } from "./credential-gate.js";
import type { CredentialGatesStore } from "../credential-gates.js";
import { createCredentialGrants } from "../credential-grants.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { memoryFleet } from "../../testing.js";
import { createHeldCards } from "../../guard/held-cards.js";

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

// Drives the gate end to end with a fake policy store and live turn: a credential releases only for a named, verified
// click, and every other path uses nothing. Each fail-closed ending gets its own test.

const BOB = { email: "bob@corp.com", role: "collaborator" } as const;
const EVE = { email: "eve@corp.com", role: "maintainer" } as const;

const policy = (over: Partial<GatePolicy> = {}): GatePolicy => ({
    subject: "DATABASE_URL",
    kind: "secret",
    approvers: ["bob@corp.com"],
    scope: "use",
    ...over,
});

// Mirrors the real store: `list` throws for a policy that exists but cannot be read, distinct from an absent one.
const memoryGates = (gates: readonly GatePolicy[], broken = false): CredentialGatesStore => ({
    list: async () => {
        if (broken) {
            throw new Error("the credential gate policy could not be read");
        }
        return gates;
    },
    set: async () => {},
    remove: async () => {},
    forName: async () => undefined,
    forCapability: async () => undefined,
});

interface Fake {
    readonly deps: CredentialGateDeps;
    readonly frames: AgentEvent[];
    readonly awaited: { readonly conversationId: string; readonly kind: string }[];
    readonly grants: ReturnType<typeof createCredentialGrants>;
    // The turn the cards went up in: ending it settles a card nobody answered.
    readonly endTurn: () => void;
    readonly held: ReturnType<typeof createHeldCards>;
    // What the conversation was woken with by a turn's close that held for a card.
    readonly woken: string[];
}

const fake = (gates: readonly GatePolicy[], over: Partial<CredentialGateDeps> = {}, broken = false): Fake => {
    const frames: AgentEvent[] = [];
    const awaited: { conversationId: string; kind: string }[] = [];
    const grants = createCredentialGrants();
    // Ending it starts the next, as a wake does.
    let turn = Promise.withResolvers<void>();
    const woken: string[] = [];
    const held = createHeldCards(async (_conversationId, prompt) => void woken.push(prompt));
    const deps: CredentialGateDeps = {
        hold: { held, finished: () => turn.promise },
        cards,
        gates: memoryGates(gates, broken),
        grants,
        liveRun: (conversationId) => ({ conversationId: conversationId ?? "sole-conv", push: (event) => frames.push(event) }),
        observe: () => {},
        awaiting: (conversationId, kind) => awaited.push({ conversationId, kind }),
        now: () => 1_700_000_000_000,
        ...over,
    };
    return { deps, frames, awaited, grants, endTurn: () => {
            turn.resolve();
            turn = Promise.withResolvers<void>();
        },
        held, woken };
};

const asked = (over: Partial<CredentialCheck> = {}): CredentialCheck => ({
    subject: "DATABASE_URL",
    kind: "secret",
    lane: "shell",
    detail: "psql $DATABASE_URL -c 'select 1'",
    conversationId: "conv-1",
    signal: new AbortController().signal,
    ...over,
});

// Answers as a specific verified person, against the next card at or after `from`; indexed so a second answer targets
// the new card, since each release adds three frames (offer, resolved, receipt).
const answerFrom = async (frames: AgentEvent[], from: number, approve: boolean, caller?: typeof BOB | typeof EVE) => {
    let raised: AgentEvent | undefined;
    for (let waited = 0; raised === undefined && waited < 2000; waited += 1) {
        raised = frames.slice(from).find((frame) => frame.kind === "credential_offer");
        if (raised === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 1));
        }
    }
    if (raised?.kind !== "credential_offer") {
        throw new Error(`no credential_offer frame was raised at or after ${from}`);
    }
    return cards.resolve({ kind: "credential_offer", requestId: raised.requestId, approve }, caller);
};

const answerCard = (frames: AgentEvent[], approve: boolean, caller?: typeof BOB | typeof EVE) => answerFrom(frames, 0, approve, caller);

it("lets an ungated credential through without raising anything", async () => {
    const { deps, frames } = fake([]);
    expect(await createCredentialGate(deps).check(asked())).toEqual({ allow: true });
    expect(frames).toEqual([]);
});

it("raises a card naming the approvers and the scope, and releases on the approver's click", async () => {
    const { deps, frames, awaited } = fake([policy()]);
    const pending = createCredentialGate(deps).check(asked({ why: "run the migration" }));
    await answerCard(frames, true, BOB);
    expect(await pending).toEqual({ allow: true, approvedBy: "bob@corp.com" });
    expect(frames[0]).toEqual({
        kind: "credential_offer",
        requestId: expect.any(String),
        offer: {
            subject: "DATABASE_URL",
            kind: "secret",
            lane: "shell",
            detail: "psql $DATABASE_URL -c 'select 1'",
            why: "run the migration",
            approvers: ["bob@corp.com"],
            scope: "use",
        },
    });
    expect(frames[2]).toEqual({ kind: "credential_receipt", requestId: expect.any(String), outcome: "released", approvedBy: "bob@corp.com" });
    expect(awaited).toEqual([{ conversationId: "conv-1", kind: "credential_offer" }]);
});

it("refuses a click from somebody the card does not name, and leaves the card standing for one it does", async () => {
    const { deps, frames } = fake([policy()]);
    const pending = createCredentialGate(deps).check(asked());
    expect(await answerCard(frames, true, EVE)).toEqual({ refused: 'Only bob@corp.com can release "DATABASE_URL".' });
    expect(await answerCard(frames, true)).toEqual({
        refused: 'Only bob@corp.com can release "DATABASE_URL", and this request carries no signed-in identity.',
    });
    await answerCard(frames, true, BOB);
    expect(await pending).toEqual({ allow: true, approvedBy: "bob@corp.com" });
});

it("records a conversation-scoped release, so the next use of the same subject asks nobody", async () => {
    const { deps, frames, grants } = fake([policy({ scope: "conversation" })]);
    const gate = createCredentialGate(deps);
    const pending = gate.check(asked());
    await answerCard(frames, true, BOB);
    await pending;
    expect(grants.has("conv-1", "DATABASE_URL")).toEqual({ approvedBy: "bob@corp.com", at: 1_700_000_000_000 });
    const framesBefore = frames.length;
    expect(await gate.check(asked())).toEqual({ allow: true, approvedBy: "bob@corp.com" });
    expect(frames.length).toBe(framesBefore);
    const second = gate.check(asked({ conversationId: "conv-2" }));
    await answerFrom(frames, framesBefore, true, BOB);
    expect(await second).toEqual({ allow: true, approvedBy: "bob@corp.com" });
    expect(grants.has("conv-2", "DATABASE_URL")).toEqual({ approvedBy: "bob@corp.com", at: 1_700_000_000_000 });
});

it("a per-use release covers that use only: it records no grant, so the next use asks again", async () => {
    const { deps, frames, grants } = fake([policy()]);
    const gate = createCredentialGate(deps);
    const first = gate.check(asked());
    await answerCard(frames, true, BOB);
    await first;
    expect(grants.has("conv-1", "DATABASE_URL")).toBeUndefined();
    const framesBefore = frames.length;
    const second = gate.check(asked());
    await answerFrom(frames, framesBefore, true, BOB);
    expect(await second).toEqual({ allow: true, approvedBy: "bob@corp.com" });
    expect(frames.filter((frame) => frame.kind === "credential_offer")).toHaveLength(2);
});

it("tells a decline apart from a turn that ended unanswered, and receipts only the decline", async () => {
    const declined = fake([policy()]);
    const pendingDecline = createCredentialGate(declined.deps).check(asked());
    await answerCard(declined.frames, false, BOB);
    expect(await pendingDecline).toEqual({
        allow: false,
        reason: expect.stringContaining("bob@corp.com declined to release"),
    });
    expect(declined.frames.at(-1)).toEqual({
        kind: "credential_receipt",
        requestId: expect.any(String),
        outcome: "refused",
        approvedBy: "bob@corp.com",
    });

    const expired = fake([policy()]);
    const pendingExpiry = createCredentialGate(expired.deps).check(asked());
    while (!expired.frames.some((frame) => frame.kind === "credential_offer")) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expired.endTurn();
    const verdict = await pendingExpiry;
    expect(verdict).toEqual({ allow: false, reason: expect.stringContaining("The turn ended before anyone released") });
    expect((verdict as { reason: string }).reason).toContain("bob@corp.com");
    expect(expired.frames.some((frame) => frame.kind === "credential_receipt")).toBe(false);
});

it("refuses when there is no live conversation to raise the card in", async () => {
    const { deps } = fake([policy()], { liveRun: () => undefined });
    const verdict = await createCredentialGate(deps).check(asked());
    expect(verdict).toEqual({ allow: false, reason: expect.stringContaining("no live conversation") });
    expect((verdict as { reason: string }).reason).toContain("bob@corp.com");
});

it("refuses a policy it cannot read, rather than treating it as nothing gated", async () => {
    const { deps, frames } = fake([policy()], {}, true);
    const verdict = await createCredentialGate(deps).check(asked());
    expect(verdict).toEqual({ allow: false, reason: expect.stringContaining("could not be read") });
    expect((verdict as { reason: string }).reason).toContain("Do not retry");
    expect(frames).toEqual([]);
});

it("only a gate of the matching kind answers for a subject", async () => {
    const { deps, frames } = fake([policy({ kind: "capability" })]);
    expect(await createCredentialGate(deps).check(asked({ kind: "secret" }))).toEqual({ allow: true });
    expect(frames).toEqual([]);
});

it("waits for the approver however long it takes: no clock refuses the card", async () => {
    jest.useFakeTimers();
    try {
        const { deps, frames } = fake([policy()]);
        const pending = createCredentialGate(deps).check(asked());
        // Well past the ten minutes a card used to be refused at.
        jest.advanceTimersByTime(3 * 60 * 60_000);
        jest.useRealTimers();
        await answerCard(frames, true, BOB);
        expect(await pending).toEqual({ allow: true, approvedBy: "bob@corp.com" });
    } finally {
        jest.useRealTimers();
    }
});

it("keeps the card up when its caller stops waiting, and the same call again collects the release without a second card", async () => {
    const { deps, frames, held } = fake([policy()]);
    const gate = createCredentialGate(deps);
    const gone = new AbortController();
    const first = gate.check(asked({ signal: gone.signal }));
    gone.abort();
    expect(await first).toEqual({ allow: false, reason: expect.stringMatching(/^Still waiting for bob@corp.com to release "DATABASE_URL"/) });
    expect(held.open("conv-1")).toHaveLength(1);

    await answerCard(frames, true, BOB);
    expect(await gate.check(asked())).toEqual({ allow: true, approvedBy: "bob@corp.com" });
    expect(frames.filter((frame) => frame.kind === "credential_offer")).toHaveLength(1);
    expect(held.open("conv-1")).toEqual([]);
});

it("wakes the conversation on a release given after its turn ended, and the repeated call passes once", async () => {
    const { deps, frames, held, woken, endTurn } = fake([policy()]);
    const gate = createCredentialGate(deps);
    const gone = new AbortController();
    const first = gate.check(asked({ signal: gone.signal }));
    gone.abort();
    await first;

    // The turn's close holds for the card the call left up.
    const closing = held.hold("conv-1", undefined);
    await answerCard(frames, true, BOB);
    await closing;
    endTurn();
    expect(woken).toHaveLength(1);
    expect(woken[0]).toContain('bob@corp.com allowed releasing "DATABASE_URL" after your turn ended. It has not been used yet:');
    expect(woken[0]).toContain("psql $DATABASE_URL -c 'select 1'");

    // The wake's turn makes the same call: released once, with no second card.
    expect(await gate.check(asked())).toEqual({ allow: true, approvedBy: "bob@corp.com" });
    expect(frames.filter((frame) => frame.kind === "credential_offer")).toHaveLength(1);
    const again = gate.check(asked());
    await answerFrom(frames, frames.length, true, BOB);
    expect(await again).toEqual({ allow: true, approvedBy: "bob@corp.com" });
    expect(frames.filter((frame) => frame.kind === "credential_offer")).toHaveLength(2);
});
