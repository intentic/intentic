import type { AgentEvent } from "@intentic/sandbox-contract";
import { expect, it } from "vitest";
import { resolveRequest } from "../agent/agent-requests.js";
import { gatedServiceRun, type OfferDeps, type OfferedRun } from "./service-offer.js";
import type { RelayedAnswer } from "./pool-services.js";

/* The spend gate, driven end to end with a fake platform and a fake live turn: what these prove is the ONE
 * property the module exists for — the platform relay is called exactly when a real reply approved the card,
 * and every other ending (skip, expiry, a dead caller, a non-member, an unknown slug) charges nothing and
 * answers with a sentence the agent can act on. */

const CATALOG: RelayedAnswer = {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
        member: true,
        credits: { allowance: 1000, remaining: 960, resetsAt: "2026-08-13T00:00:00Z" },
        services: [{ slug: "acme-research", publisher: "acme", name: "Acme Research", description: "Deep research runs.", creditsPerRun: 40 }],
    }),
};

interface Fake {
    readonly deps: OfferDeps;
    readonly frames: AgentEvent[];
    readonly observed: AgentEvent[];
    readonly ran: string[];
}

const fake = (over: Partial<OfferDeps> = {}): Fake => {
    const frames: AgentEvent[] = [];
    const observed: AgentEvent[] = [];
    const ran: string[] = [];
    const deps: OfferDeps = {
        catalog: async () => CATALOG,
        run: async (slug) => {
            ran.push(slug);
            return { status: 200, contentType: "application/json", body: `{"answer":42}`, remaining: "920" };
        },
        liveRun: (conversationId) => ({ conversationId: conversationId ?? "sole-conv", push: (event) => frames.push(event) }),
        observe: (_conversationId, event) => observed.push(event),
        ...over,
    };
    return { deps, frames, observed, ran };
};

const offered = (over: Partial<OfferedRun> = {}): OfferedRun => ({
    slug: "acme-research",
    body: `{"query":"communities"}`,
    conversationId: "conv-1",
    why: "a deep pass beats my free scan here",
    signal: new AbortController().signal,
    ...over,
});

// The card's requestId exists only inside the frame the gate pushed — wait for it, then answer as the route
// handler would (resolveRequest is the same registry POST /agent/reply resolves).
const answerCard = async (frames: AgentEvent[], approve: boolean): Promise<void> => {
    while (frames.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const raised = frames[0]!;
    if (raised.kind !== "service_offer") {
        throw new Error(`expected a service_offer frame, got ${raised.kind}`);
    }
    resolveRequest({ kind: "service_offer", requestId: raised.requestId, approve });
};

it("relays the run only after the click, and receipts what the platform answered", async () => {
    const { deps, frames, observed, ran } = fake();
    const pending = gatedServiceRun(deps, offered());
    await answerCard(frames, true);
    const answer = await pending;
    expect(ran).toEqual(["acme-research"]);
    expect(answer.status).toBe(200);
    expect(answer.remaining).toBe("920");
    // The card carried the platform's numbers and the agent's two contributions, nothing else invented.
    const raised = frames[0]!;
    expect(raised).toMatchObject({
        kind: "service_offer",
        offer: {
            slug: "acme-research",
            creditsPerRun: 40,
            credits: { remaining: 960, allowance: 1000 },
            request: `{"query":"communities"}`,
            why: "a deep pass beats my free scan here",
        },
    });
    // resolved (with the reply) and then the served receipt followed it into the frame log and the registry.
    expect(frames.map((frame) => frame.kind)).toEqual(["service_offer", "resolved", "service_receipt"]);
    expect(frames[2]).toMatchObject({ kind: "service_receipt", outcome: "ok", credits: 40, remaining: 920 });
    expect(observed.map((frame) => frame.kind)).toEqual(["service_offer", "resolved", "service_receipt"]);
});

it("a skip spends nothing and tells the agent to continue without it", async () => {
    const { deps, frames, ran } = fake();
    const pending = gatedServiceRun(deps, offered());
    await answerCard(frames, false);
    const answer = await pending;
    expect(ran).toEqual([]);
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { type: "declined" } });
    // No receipt — nothing happened; the resolved frame already says how it ended.
    expect(frames.map((frame) => frame.kind)).toEqual(["service_offer", "resolved"]);
});

it("an offer nobody answers expires without spending", async () => {
    const { deps, frames, ran } = fake({ deadlineMs: 5 });
    const answer = await gatedServiceRun(deps, offered());
    expect(ran).toEqual([]);
    expect(answer.status).toBe(408);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { type: "unanswered" } });
    expect(frames.map((frame) => frame.kind)).toEqual(["service_offer", "resolved"]);
    // The abort stand-in is nobody's decision: the resolved frame carries no reply, so the card freezes
    // cancelled rather than replaying as a skip somebody chose.
    expect((frames[1] as { reply?: unknown }).reply).toBeUndefined();
});

it("the caller dying under the card settles it without spending", async () => {
    const controller = new AbortController();
    const { deps, frames, ran } = fake();
    const pending = gatedServiceRun(deps, offered({ signal: controller.signal }));
    while (frames.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    controller.abort();
    const answer = await pending;
    expect(ran).toEqual([]);
    expect(answer.status).toBe(408);
});

it("a non-member is refused before any card goes up", async () => {
    const { deps, frames, ran } = fake({
        catalog: async () => ({
            ...CATALOG,
            body: JSON.stringify({
                member: false,
                services: [{ slug: "acme-research", publisher: "acme", name: "Acme Research", description: "d", creditsPerRun: 40 }],
            }),
        }),
    });
    const answer = await gatedServiceRun(deps, offered());
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { type: "membership_required" } });
    expect(frames).toEqual([]);
    expect(ran).toEqual([]);
});

it("an unknown slug is a sentence, not a card", async () => {
    const { deps, frames } = fake();
    const answer = await gatedServiceRun(deps, offered({ slug: "nope" }));
    expect(answer.status).toBe(404);
    expect(frames).toEqual([]);
});

it("no live conversation refuses the spend outright", async () => {
    const { deps } = fake({ liveRun: () => undefined });
    const answer = await gatedServiceRun(deps, offered({ conversationId: undefined }));
    expect(answer.status).toBe(409);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { type: "no_conversation" } });
});

it("the reserved owner names are no conversation at all", async () => {
    const asked: (string | undefined)[] = [];
    const { deps } = fake({
        liveRun: (conversationId) => {
            asked.push(conversationId);
            return undefined;
        },
    });
    await gatedServiceRun(deps, offered({ conversationId: "daemon" }));
    await gatedServiceRun(deps, offered({ conversationId: "one-shot" }));
    expect(asked).toEqual([undefined, undefined]);
});

it("a platform refusal on the catalog is relayed verbatim", async () => {
    const { deps, frames } = fake({
        catalog: async () => ({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({ error: "the creator pool is not enabled on this platform" }),
        }),
    });
    const answer = await gatedServiceRun(deps, offered());
    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.body)).toMatchObject({ error: "the creator pool is not enabled on this platform" });
    expect(frames).toEqual([]);
});

it("a service that fails to answer receipts as refunded", async () => {
    const { deps, frames } = fake({
        run: async () => ({
            status: 502,
            contentType: "application/json",
            body: JSON.stringify({ error: { type: "service_unavailable", message: "did not answer" } }),
        }),
    });
    const pending = gatedServiceRun(deps, offered());
    await answerCard(frames, true);
    const answer = await pending;
    expect(answer.status).toBe(502);
    expect(frames[2]).toMatchObject({ kind: "service_receipt", outcome: "refunded", credits: 40 });
});

it("a post-click platform refusal receipts as refused", async () => {
    const { deps, frames } = fake({
        run: async () => ({
            status: 429,
            contentType: "application/json",
            body: JSON.stringify({ error: { type: "insufficient_credits", message: "40 needed" } }),
        }),
    });
    const pending = gatedServiceRun(deps, offered());
    await answerCard(frames, true);
    await pending;
    expect(frames[2]).toMatchObject({ kind: "service_receipt", outcome: "refused" });
});
