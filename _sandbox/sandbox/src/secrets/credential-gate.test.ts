import type { AgentEvent, CredentialGate as GatePolicy } from "@intentic/sandbox-contract";
import { expect, it } from "vitest";
import { resolveRequest } from "../agent/agent-requests.js";
import { createCredentialGate, type CredentialCheck, type CredentialGateDeps } from "./credential-gate.js";
import type { CredentialGatesStore } from "./credential-gates.js";
import { createCredentialGrants } from "./credential-grants.js";

/* THE RELEASE GATE, driven end to end with a fake policy file and a fake live turn. What these prove is the
 * one property the module exists for: a gated credential is used exactly when a NAMED person clicked (or
 * already clicked, for a conversation-scoped gate), and every other ending uses nothing and answers with a
 * sentence the agent can act on that names who could have said yes.
 *
 * The four fail-closed endings get a test each, because each of them is a place where "allow" would be the
 * easy accident: an unreadable policy, an unattended turn, no live conversation, and an approval arriving
 * with no verified identity behind it. */

const BOB = { email: "bob@corp.com", role: "collaborator" } as const;
const EVE = { email: "eve@corp.com", role: "maintainer" } as const;

const policy = (over: Partial<GatePolicy> = {}): GatePolicy => ({
    subject: "DATABASE_URL",
    kind: "secret",
    approvers: ["bob@corp.com"],
    scope: "use",
    ...over,
});

// The store's real semantics in memory, including the one that matters most: `list` THROWS for a policy that
// exists and cannot be read, because the file store distinguishes that from an absent one (credential-gates.ts).
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

/* Answer the way the reply route does: as a specific verified person, against the NEXT card raised at or
 * after `from`. Indexed rather than "the first frame" because a test that asks twice has to answer the second
 * card and not re-answer the first, and the frame log grows by three per release (offer, resolved, receipt). */
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
    // The card is the daemon's own account of what is about to happen: subject, lane, where it would go, the
    // approvers off the policy, the scope off the policy, and the model's one line of why.
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
    // …and the receipt names WHO, which is the only road that name travels: the reply carries no sender.
    expect(frames[2]).toEqual({ kind: "credential_receipt", requestId: expect.any(String), outcome: "released", approvedBy: "bob@corp.com" });
    expect(notified).toEqual(["conv-1"]);
});

it("refuses a click from somebody the card does not name, and leaves the card standing for one it does", async () => {
    const { deps, frames } = fake([policy()]);
    const pending = createCredentialGate(deps).check(asked());
    // A stranger's yes is refused with the sentence, and the turn is still parked afterwards.
    expect(await answerCard(frames, true, EVE)).toEqual({ refused: 'Only bob@corp.com can release "DATABASE_URL".' });
    // A reply with no verified identity at all is refused too: fail closed, never "whoever reached the route".
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
    // The second use raises nothing and still reports who released it, which is what the ledger row records.
    const framesBefore = frames.length;
    expect(await gate.check(asked())).toEqual({ allow: true, approvedBy: "bob@corp.com" });
    expect(frames.length).toBe(framesBefore);
    // Another conversation is another decision: the grant does not leak sideways, so a fresh card goes up.
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
    // A fresh card for the second use, which is what "one click releases exactly one use" means.
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
    // A person said no, so the card carries a receipt saying who.
    expect(declined.frames.at(-1)).toEqual({
        kind: "credential_receipt",
        requestId: expect.any(String),
        outcome: "refused",
        approvedBy: "bob@corp.com",
    });

    /* NOBODY ANSWERED is a different refusal and writes NO receipt: reading a deadline as "refused" would put
     * words in an approver's mouth, which matters more here than anywhere else because the whole feature is
     * about attributing a decision to a person. */
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
    /* The whole fail-closed argument in one test: the file store answers `[]` only for a policy that has
     * never been written, and THROWS for one that exists and cannot be parsed, because reading the second as
     * the first would silently unlock every gated credential in the sandbox. */
    const { deps, frames } = fake([policy()], {}, true);
    const verdict = await createCredentialGate(deps).check(asked());
    expect(verdict).toEqual({ allow: false, reason: expect.stringContaining("could not be read") });
    expect((verdict as { reason: string }).reason).toContain("Do not retry");
    expect(frames).toEqual([]);
});

it("only a gate of the matching kind answers for a subject", async () => {
    // A capability that happens to share an env key's name must not answer for it, and vice versa.
    const { deps, frames } = fake([policy({ kind: "capability" })]);
    expect(await createCredentialGate(deps).check(asked({ kind: "secret" }))).toEqual({ allow: true });
    expect(frames).toEqual([]);
});
