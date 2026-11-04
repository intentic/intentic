import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { ProvenCaller } from "./auth.js";
import { framedEvent, framedSummary, listedTo, visibleTo } from "./fleet-scope.js";
import { readVia, sealedCard } from "./seal-scope.js";
import { provesOwner, turnProof } from "../seams/workload-stamp.js";

// Who reads a private conversation, as the pure rules every door applies: its readers, a grant for a day, an opening while
// it lasts, and nobody else whatever their role; and what everyone else it is listed to is shown instead.

const NOW = 1_800_000_000_000;
const anna: ProvenCaller = { email: "anna@example.com", role: "collaborator", methods: ["google"] };
const ola: ProvenCaller = { email: "ola@example.com", role: "collaborator", methods: ["google"] };
const owner: ProvenCaller = { email: "radek@example.com", role: "owner", methods: ["google"] };
const full: ProvenCaller = { email: "max@example.com", role: "maintainer", methods: ["google"] };

const seal = {
    readers: [{ email: "anna@example.com", name: "Anna" }],
    grants: [{ email: "ola@example.com", until: NOW + 1000, by: "anna@example.com" }],
    // Long over, by the fixed clock and by the real one that visibleTo reads.
    opens: [{ id: "o1", email: "radek@example.com", at: 0, until: 1, reason: "Customer data incident #212" }],
};

const summary = (extra: Partial<AgentSummary> = {}): AgentSummary => ({
    id: "c1",
    status: "idle",
    provider: "claude",
    harness: "native",
    updatedAt: NOW,
    title: "Draft feedback for Q4 reviews",
    activity: "Reading reviews.md",
    failure: "the provider stopped",
    diff: { files: 2, insertions: 120, deletions: 34 },
    attention: { plan: true, question: true, permission: false, capability: false, credential: false, conflict: true, need: false },
    owner: { email: "anna@example.com", name: "Anna", since: NOW - 100 },
    seal,
    ...extra,
});

describe("readVia", () => {
    test("a reader for good, a grant until it ends, an opening until it ends, compared folded", () => {
        expect(readVia("Anna@Example.com", seal, NOW)).toEqual({ via: "reader" });
        expect(readVia("ola@example.com", seal, NOW)).toEqual({ via: "grant", until: NOW + 1000 });
        expect(readVia("ola@example.com", seal, NOW + 1000)).toBeUndefined();
        expect(readVia("radek@example.com", { ...seal, opens: [{ ...seal.opens[0]!, until: NOW + 5 }] }, NOW)).toEqual({ via: "open", until: NOW + 5 });
    });

    test("an opening waiting on a second person, or refused, reads nothing", () => {
        const open = { ...seal.opens[0]!, until: NOW + 5 };
        expect(readVia("radek@example.com", { ...seal, opens: [{ ...open, pending: true as const }] }, NOW)).toBeUndefined();
        expect(readVia("radek@example.com", { ...seal, opens: [{ ...open, refusedBy: { email: "max@example.com", at: NOW } }] }, NOW)).toBeUndefined();
    });

    test("nobody without an address reads it", () => {
        expect(readVia(undefined, seal, NOW)).toBeUndefined();
        expect(readVia("", seal, NOW)).toBeUndefined();
    });
});

describe("visibleTo with a seal", () => {
    test("neither the owner nor Full access reads past it; its card is still listed to them", () => {
        expect(visibleTo(owner, { seal })).toBe(false);
        expect(visibleTo(full, { seal })).toBe(false);
        expect(listedTo(owner, { seal })).toBe(true);
        expect(listedTo(full, { seal })).toBe(true);
        expect(visibleTo(anna, { seal })).toBe(true);
    });

    test("the owner's own tools read nothing sealed", () => {
        expect(visibleTo(undefined, { seal })).toBe(false);
        expect(visibleTo(undefined, {})).toBe(true);
    });
});

describe("sealedCard", () => {
    test("keeps whose it is, where it stands and its diff, and drops every word", () => {
        const card = sealedCard(summary(), ola);
        expect(card.title).toBeUndefined();
        expect(card.activity).toBeUndefined();
        expect(card.failure).toBeUndefined();
        expect(card.diff).toEqual({ files: 2, insertions: 120, deletions: 34 });
        expect(card.owner?.email).toBe("anna@example.com");
        expect(card.attention).toEqual({ plan: false, question: false, permission: false, capability: false, credential: false, conflict: true, need: false });
        expect(card.seal).toEqual({ sealed: true, readers: [{ email: "anna@example.com", name: "Anna" }] });
    });

    test("tells the owner it may open it without asking, and nobody else", () => {
        expect(sealedCard(summary(), owner).seal?.canOpen).toBe(true);
        expect(sealedCard(summary(), full).seal?.canOpen).toBeUndefined();
    });

    test("shows an opening waiting on a second person to its opener and to Full access, who may agree", () => {
        const pending = { id: "o2", email: "radek@example.com", at: NOW, until: NOW + 10, reason: "Customer data incident #212", pending: true as const };
        const waiting = summary({ seal: { ...seal, opens: [pending] } });
        expect(sealedCard(waiting, owner).seal).toMatchObject({ pending: { id: "o2" } });
        expect(sealedCard(waiting, owner).seal?.canApprove).toBeUndefined();
        expect(sealedCard(waiting, full).seal).toMatchObject({ pending: { id: "o2" }, canApprove: true });
        expect(sealedCard(waiting, ola).seal?.pending).toBeUndefined();
    });
});

describe("framedSummary", () => {
    test("a reader gets it whole, with how they read it", () => {
        expect(framedSummary(anna, summary(), NOW)).toMatchObject({ title: "Draft feedback for Q4 reviews", seal: { via: "reader" } });
        expect(framedSummary(ola, summary(), NOW)).toMatchObject({ title: "Draft feedback for Q4 reviews", seal: { via: "grant", until: NOW + 1000 } });
    });

    test("anyone else it is listed to gets the sealed card", () => {
        expect(framedSummary(owner, summary(), NOW)?.title).toBeUndefined();
        expect(framedSummary(owner, summary(), NOW)?.seal?.sealed).toBe(true);
    });

    test("an unsealed conversation is untouched", () => {
        const open = summary({ seal: undefined });
        expect(framedSummary(owner, open, NOW)).toBe(open);
    });

    test("the event stream cuts the cards for a program too", () => {
        const framed = framedEvent(undefined, undefined, { kind: "agents", agents: [summary()], rev: 1 }, () => undefined);
        expect(framed).toMatchObject({ kind: "agents", agents: [{ id: "c1", seal: { sealed: true } }] });
        expect(framed !== undefined && "agents" in framed ? framed.agents[0]?.title : "gone").toBeUndefined();
    });
});

describe("the turn proof", () => {
    test("proves the conversation it was made for and no other", () => {
        expect(provesOwner("c1", turnProof("c1"))).toBe(true);
        expect(provesOwner("c2", turnProof("c1"))).toBe(false);
        expect(provesOwner("c1", undefined)).toBe(false);
        expect(provesOwner("c1", "x".repeat(64))).toBe(false);
    });
});
