import type { DraftSummary } from "@intentic/sandbox-contract";
import { beforeEach, expect, test, vi } from "vitest";
import type { Services } from "../composition.js";

/* The publisher's two jobs, tested where getting them wrong is expensive: WHEN it wakes, and WHICH door each
 * post goes through. Both are decided from the queue on disk rather than from anything held in memory, so the
 * fake below is a real store's worth of behaviour — read, write, read back — and nothing else is stubbed
 * except the two doors themselves. */

const startTurn = vi.fn(async () => undefined);
const sendDiscord = vi.fn(async () => ({ url: "https://discord.com/channels/1/2/3" }));

vi.mock("../agent/agent.routes.js", () => ({ streamAgent: vi.fn() }));
vi.mock("../agent/turn-resume.js", () => ({ startConversationTurn: (...args: unknown[]) => startTurn(...(args as [])) }));
vi.mock("../system/runtime-watch.js", () => ({ publishRuntimeChange: vi.fn() }));
vi.mock("./discord-post.js", async (importOriginal) => ({
    // The real predicate — whether a draft can go the fast way is part of what is under test — with only the
    // network call replaced.
    ...(await importOriginal<typeof import("./discord-post.js")>()),
    postToDiscord: (...args: unknown[]) => sendDiscord(...(args as [])),
}));

const { createDraftsPublisher, nextDueAt } = await import("./drafts-publisher.js");

const NOW = 1_700_000_000_000;

// `actsAs` is on the default because the default platform is a browser one, and a browser draft without a
// persona is not the ordinary case — it is its own failure, tested on its own below.
const draft = (overrides: Partial<DraftSummary> & { id: string }): DraftSummary => ({
    platform: "reddit",
    actsAs: "poster",
    content: "hello",
    status: "proposed",
    ...overrides,
});

// The turn a call to startConversationTurn was given — the third argument, which is the whole request.
const turnOf = (call: number): { prompt: string; actsAs?: string; conversationId: string } =>
    (startTurn.mock.calls[call] as unknown as [unknown, unknown, { prompt: string; actsAs?: string; conversationId: string }])[2];

// A drafts store that behaves like the file one: upsert replaces by id, list returns what is there now.
const servicesWith = (...seed: DraftSummary[]) => {
    const rows = new Map(seed.map((entry) => [entry.id, entry]));
    return {
        drafts: {
            list: async () => ({ drafts: [...rows.values()], invalid: [] }),
            upsert: async (entry: DraftSummary) => void rows.set(entry.id, entry),
            remove: async (id: string) => rows.delete(id),
        },
        capabilities: { get: async () => ({ id: "discord", kind: "cli", config: { provider: "discord", botToken: "t" } }) },
        // The cast the publisher checks `actsAs` against — the fixture's default face plus the two the
        // multi-persona test uses.
        personas: { list: async () => [{ id: "poster", capabilities: [] }, { id: "alice", capabilities: [] }, { id: "bob", capabilities: [] }] },
        logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
        rows,
    } as unknown as Services & { rows: Map<string, DraftSummary> };
};

beforeEach(() => {
    startTurn.mockClear();
    sendDiscord.mockClear();
});

test("the next wake is the soonest approved post, and there is none when nothing is approved", () => {
    expect(nextDueAt([draft({ id: "a" }), draft({ id: "b", status: "posted" })], NOW)).toBeUndefined();
    expect(nextDueAt([draft({ id: "a", status: "approved", scheduledAt: NOW + 5_000 })], NOW)).toBe(NOW + 5_000);
    // Soonest wins, and anything already past due answers `now` — a queue that came due while the daemon was
    // down has to go out on the next arm, not at whatever future time happens to sort first.
    expect(
        nextDueAt(
            [draft({ id: "a", status: "approved", scheduledAt: NOW + 5_000 }), draft({ id: "b", status: "approved", scheduledAt: NOW - 60_000 })],
            NOW,
        ),
    ).toBe(NOW);
});

test("a due Discord post is sent by code, and never reaches an agent turn", async () => {
    const services = servicesWith(draft({ id: "d", platform: "discord", target: "123456789", status: "approved", scheduledAt: NOW - 1 }));
    await createDraftsPublisher(services).publishDue(NOW);
    expect(sendDiscord).toHaveBeenCalledOnce();
    expect(startTurn).not.toHaveBeenCalled();
    expect(services.rows.get("d")).toMatchObject({ status: "posted", postedUrl: "https://discord.com/channels/1/2/3" });
});

test("a browser-only platform gets one turn for the whole batch", async () => {
    const services = servicesWith(
        draft({ id: "r1", status: "approved", scheduledAt: NOW - 1 }),
        draft({ id: "r2", status: "approved", scheduledAt: NOW - 1 }),
    );
    await createDraftsPublisher(services).publishDue(NOW);
    // One turn, not one per post: what a turn costs is that it exists.
    expect(startTurn).toHaveBeenCalledOnce();
    expect(turnOf(0).prompt).toContain("r1.json");
    expect(turnOf(0).prompt).toContain("r2.json");
    // And it wakes wearing the face the drafts named. Without this the turn is unattended and unpinned, which
    // is denied every logged-in account — so it could not reach the Reddit login these posts need.
    expect(turnOf(0).actsAs).toBe("poster");
    // Marked before the turn starts — a turn that dies must leave a stuck post, never a due one.
    expect(services.rows.get("r1")?.status).toBe("posting");
});

test("a browser post that names no persona is failed unsent, with a reason the owner can act on", async () => {
    const services = servicesWith(draft({ id: "orphan", actsAs: undefined, status: "approved", scheduledAt: NOW - 1 }));
    await createDraftsPublisher(services).publishDue(NOW);
    // No turn at all. Waking one would wake it without accounts, and it would report the login as missing —
    // which is exactly the wrong sentence to leave in front of the owner.
    expect(startTurn).not.toHaveBeenCalled();
    expect(services.rows.get("orphan")?.status).toBe("failed");
    expect(services.rows.get("orphan")?.error).toContain("actsAs");
});

test("a persona no card carries is failed unsent too, and named in the reason", async () => {
    // A card renamed on one side only, or a workspace cloned before its personas were committed. The turn would
    // arrive with no account at all, so this is the same failure as naming nobody — said in the queue instead.
    const services = servicesWith(draft({ id: "ghost", actsAs: "deleted-card", status: "approved", scheduledAt: NOW - 1 }));
    await createDraftsPublisher(services).publishDue(NOW);
    expect(startTurn).not.toHaveBeenCalled();
    expect(services.rows.get("ghost")?.status).toBe("failed");
    expect(services.rows.get("ghost")?.error).toContain("deleted-card");
});

test("two faces are two turns, each carrying only its own posts", async () => {
    const services = servicesWith(
        draft({ id: "a1", actsAs: "alice", status: "approved", scheduledAt: NOW - 1 }),
        draft({ id: "b1", actsAs: "bob", status: "approved", scheduledAt: NOW - 1 }),
        draft({ id: "a2", actsAs: "alice", status: "approved", scheduledAt: NOW - 1 }),
    );
    await createDraftsPublisher(services).publishDue(NOW);
    expect(startTurn).toHaveBeenCalledTimes(2);
    const byFace = new Map([0, 1].map((call) => [turnOf(call).actsAs, turnOf(call)]));
    expect([...byFace.keys()].toSorted()).toEqual(["alice", "bob"]);
    // Alice's turn carries both of hers and none of Bob's — a turn wears one face, so a batch that mixed them
    // would hand a post to an account that cannot send it.
    expect(byFace.get("alice")?.prompt).toContain("a2.json");
    expect(byFace.get("alice")?.prompt).not.toContain("b1.json");
    expect(byFace.get("bob")?.prompt).toContain("b1.json");
    // Two turns in one sweep still need two distinct conversations.
    expect(turnOf(0).conversationId).not.toBe(turnOf(1).conversationId);
});

test("a Discord post needs no persona — the daemon sends it with a stored key, not a browser", async () => {
    const services = servicesWith(
        draft({ id: "d", platform: "discord", actsAs: undefined, target: "123456789", status: "approved", scheduledAt: NOW - 1 }),
    );
    await createDraftsPublisher(services).publishDue(NOW);
    expect(sendDiscord).toHaveBeenCalledOnce();
    expect(services.rows.get("d")?.status).toBe("posted");
});

test("a Discord draft the fast path cannot carry falls back to the turn instead of failing", async () => {
    const services = servicesWith(
        // An attachment needs a multipart upload, and a channel named rather than numbered needs a lookup —
        // both are work only the turn can do.
        draft({ id: "media", platform: "discord", target: "123456789", media: ["a.png"], status: "approved", scheduledAt: NOW - 1 }),
        draft({ id: "named", platform: "discord", target: "#releases", status: "approved", scheduledAt: NOW - 1 }),
    );
    await createDraftsPublisher(services).publishDue(NOW);
    expect(sendDiscord).not.toHaveBeenCalled();
    expect(startTurn).toHaveBeenCalledOnce();
});

test("a refused Discord post lands as a failure the owner can read, not a silent drop", async () => {
    sendDiscord.mockRejectedValueOnce(new Error("Discord refused the post (HTTP 403): missing access"));
    const services = servicesWith(draft({ id: "d", platform: "discord", target: "123456789", status: "approved", scheduledAt: NOW - 1 }));
    await createDraftsPublisher(services).publishDue(NOW);
    expect(services.rows.get("d")).toMatchObject({ status: "failed" });
    expect(services.rows.get("d")?.error).toContain("403");
});

test("nothing not yet due is touched", async () => {
    const services = servicesWith(draft({ id: "held", status: "approved", scheduledAt: NOW + 30_000 }), draft({ id: "waiting", status: "proposed" }));
    await createDraftsPublisher(services).publishDue(NOW);
    expect(startTurn).not.toHaveBeenCalled();
    expect(services.rows.get("held")?.status).toBe("approved");
});

test("two sweeps at once cannot send the same post twice", async () => {
    // The failure this guards is unrecoverable: both passes read `approved` before either wrote `posting`.
    const services = servicesWith(draft({ id: "d", platform: "discord", target: "123456789", status: "approved", scheduledAt: NOW - 1 }));
    const publisher = createDraftsPublisher(services);
    await Promise.all([publisher.publishDue(NOW), publisher.publishDue(NOW)]);
    expect(sendDiscord).toHaveBeenCalledOnce();
});
