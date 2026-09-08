import type { AgentEvent, CredentialGate as GatePolicy } from "@intentic/sandbox-contract";
import { expect, it } from "vitest";
import { resolveRequest } from "../agent/tools/agent-requests.js";
import { createCredentialGate, type CredentialCheck, type CredentialGateDeps } from "./credential-gate.js";
import type { CredentialGatesStore } from "./credential-gates.js";
import { createCredentialGrants } from "./credential-grants.js";

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
    readonly notified: string[];
    readonly grants: ReturnType<typeof createCredentialGrants>;
}

const fake = (gates: readonly GatePolicy[], over: Partial<CredentialGateDeps> = {}, broken = false): Fake => {
    const frames: AgentEvent[] = [];
    const notified: string[] = [];
    const grants = createCredentialGrants();
    const deps: CredentialGateDeps = {
        gates: memoryGates(gates, broken),
        grants,
        liveRun: (conversationId) => ({ conversationId: conversationId ?? "sole-conv", push: (event) => frames.push(event) }),
        observe: () => {},
        notify: (conversationId) => notified.push(conversationId),
        now: () => 1_700_000_000_000,
        ...over,
    };
    return { deps, frames, notified, grants };
};

const asked = (over: Partial<CredentialCheck> = {}): CredentialCheck => ({
    subject: "DATABASE_URL",
    kind: "secret",
    lane: "shell",
    detail: "psql $DATABASE_URL -c 'select 1'",
    conversationId: "conv-1",
    unattended: false,
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
    return resolveRequest({ kind: "credential_offer", requestId: raised.requestId, approve }, caller);
};

const answerCard = (frames: AgentEvent[], approve: boolean, caller?: typeof BOB | typeof EVE) => answerFrom(frames, 0, approve, caller);

it("lets an ungated credential through without raising anything", async () => {
    const { deps, frames } = fake([]);
    expect(await createCredentialGate(deps).check(asked())).toEqual({ allow: true });
    expect(frames).toEqual([]);
});

it("raises a card naming the approvers and the scope, and releases on the approver's click", async () => {
    const { deps, frames, notified } = fake([policy()]);
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
    expect(notified).toEqual(["conv-1"]);
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

it("tells a decline apart from a deadline, and receipts only the decline", async () => {
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

    const expired = fake([policy()], { deadlineMs: 1 });
    const verdict = await createCredentialGate(expired.deps).check(asked());
    expect(verdict).toEqual({ allow: false, reason: expect.stringContaining("went unanswered and expired") });
    expect((verdict as { reason: string }).reason).toContain("bob@corp.com");
    expect(expired.frames.some((frame) => frame.kind === "credential_receipt")).toBe(false);
});

it("refuses an unattended turn without raising a card, and names who could have released it", async () => {
    const { deps, frames } = fake([policy()]);
    const verdict = await createCredentialGate(deps).check(asked({ unattended: true }));
    expect(verdict).toEqual({ allow: false, reason: expect.stringContaining("unattended") });
    expect((verdict as { reason: string }).reason).toContain("bob@corp.com");
    expect((verdict as { reason: string }).reason).toContain("Do not retry");
    expect(frames).toEqual([]);
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
