import type { ActionApprovalSummary, ApprovalSummary, PostApprovalSummary } from "@intentic/sandbox-contract";
import { beforeEach, expect, test, vi } from "vitest";
import type { Services } from "../composition.js";

/* The executor's two jobs, tested where getting them wrong is expensive: WHEN it wakes, and WHICH door each
 * item goes through. Both are decided from the queue on disk rather than from anything held in memory, so the
 * fake below is a real store's worth of behaviour: read, write, read back, and nothing else is stubbed
 * except the two doors themselves. */

const startTurn = vi.fn(async () => undefined);
const sendDiscord = vi.fn(async () => ({ url: "https://discord.com/channels/1/2/3" }));

vi.mock("../agent/agent.routes.js", () => ({ streamAgent: vi.fn() }));
vi.mock("../agent/turn-resume.js", () => ({ startConversationTurn: (...args: unknown[]) => startTurn(...(args as [])) }));
vi.mock("../system/runtime-watch.js", () => ({ publishRuntimeChange: vi.fn() }));
vi.mock("./discord-post.js", async (importOriginal) => ({
    // The real predicate, whether a post can go the fast way is part of what is under test: with only the
    // network call replaced.
    ...(await importOriginal<typeof import("./discord-post.js")>()),
    postToDiscord: (...args: unknown[]) => sendDiscord(...(args as [])),
}));

const { createApprovalsExecutor, nextDueAt } = await import("./approvals-executor.js");

const NOW = 1_700_000_000_000;

// `actsAs` is on the default because the default platform is a browser one, and a browser post without a
// persona is not the ordinary case: it is its own failure, tested on its own below.
const post = (overrides: Partial<PostApprovalSummary> & { id: string }): PostApprovalSummary => ({
    kind: "post",
    platform: "reddit",
    actsAs: "poster",
    content: "hello",
    status: "proposed",
    ...overrides,
});

const action = (overrides: Partial<ActionApprovalSummary> & { id: string }): ActionApprovalSummary => ({
    kind: "action",
    summary: "Book the hotel",
    instructions: "Open booking.com and book the Adlon for 12–14 March.",
    status: "approved",
    scheduledAt: NOW - 1,
    ...overrides,
});

// The turn a call to startConversationTurn was given: the third argument, which is the whole request.
const turnOf = (call: number): { prompt: string; actsAs?: string; conversationId: string; title?: string } =>
    (startTurn.mock.calls[call] as unknown as [unknown, unknown, { prompt: string; actsAs?: string; conversationId: string; title?: string }])[2];

// A store that behaves like the file one: upsert replaces by id, list returns what is there now.
const servicesWith = (...seed: ApprovalSummary[]) => {
    const rows = new Map(seed.map((entry) => [entry.id, entry]));
    return {
        approvals: {
            list: async () => ({ approvals: [...rows.values()], invalid: [] }),
            upsert: async (entry: ApprovalSummary) => void rows.set(entry.id, entry),
            remove: async (id: string) => rows.delete(id),
        },
        capabilities: { get: async () => ({ id: "discord", kind: "cli", config: { provider: "discord", botToken: "t" } }) },
        // The cast the executor checks `actsAs` against: the fixture's default face plus the ones the
        // multi-persona tests use.
        personas: {
            list: async () => [
                { id: "poster", capabilities: [] },
                { id: "alice", capabilities: [] },
                { id: "bob", capabilities: [] },
                { id: "travel", capabilities: [] },
            ],
        },
        logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
        rows,
    } as unknown as Services & { rows: Map<string, ApprovalSummary> };
};

beforeEach(() => {
    startTurn.mockClear();
    sendDiscord.mockClear();
});

test("the next wake is the soonest approved item, and there is none when nothing is approved", () => {
    expect(nextDueAt([post({ id: "a" }), post({ id: "b", status: "done" })], NOW)).toBeUndefined();
    expect(nextDueAt([post({ id: "a", status: "approved", scheduledAt: NOW + 5_000 })], NOW)).toBe(NOW + 5_000);
    // Soonest wins, and anything already past due answers `now`: a queue that came due while the daemon was
    // down has to go out on the next arm, not at whatever future time happens to sort first.
    expect(
        nextDueAt(
            [post({ id: "a", status: "approved", scheduledAt: NOW + 5_000 }), post({ id: "b", status: "approved", scheduledAt: NOW - 60_000 })],
            NOW,
        ),
    ).toBe(NOW);
    // An action counts exactly like a post: the timer is about the queue, not about one kind.
    expect(nextDueAt([action({ id: "act", scheduledAt: NOW + 2_000 })], NOW)).toBe(NOW + 2_000);
});

test("a due Discord post is sent by code, and never reaches an agent turn", async () => {
    const services = servicesWith(post({ id: "d", platform: "discord", target: "123456789", status: "approved", scheduledAt: NOW - 1 }));
    await createApprovalsExecutor(services).runDue(NOW);
    expect(sendDiscord).toHaveBeenCalledOnce();
    expect(startTurn).not.toHaveBeenCalled();
    expect(services.rows.get("d")).toMatchObject({ status: "done", result: "https://discord.com/channels/1/2/3" });
});

test("a browser-only platform gets one turn for the whole batch", async () => {
    const services = servicesWith(
        post({ id: "r1", status: "approved", scheduledAt: NOW - 1 }),
        post({ id: "r2", status: "approved", scheduledAt: NOW - 1 }),
    );
    await createApprovalsExecutor(services).runDue(NOW);
    // One turn, not one per post: what a turn costs is that it exists.
    expect(startTurn).toHaveBeenCalledOnce();
    expect(turnOf(0).prompt).toContain("r1.json");
    expect(turnOf(0).prompt).toContain("r2.json");
    expect(turnOf(0).prompt).toContain(".intentic/config/approvals/");
    // And it wakes wearing the face the posts named. Without this the turn is unattended and unpinned, which
    // is denied every logged-in account, so it could not reach the Reddit login these posts need.
    expect(turnOf(0).actsAs).toBe("poster");
    // Marked before the turn starts: a turn that dies must leave a stuck item, never a due one.
    expect(services.rows.get("r1")?.status).toBe("running");
});

test("a browser post that names no persona is failed unsent, with a reason the owner can act on", async () => {
    const services = servicesWith(post({ id: "orphan", actsAs: undefined, status: "approved", scheduledAt: NOW - 1 }));
    await createApprovalsExecutor(services).runDue(NOW);
    // No turn at all. Waking one would wake it without accounts, and it would report the login as missing:
    // which is exactly the wrong sentence to leave in front of the owner.
    expect(startTurn).not.toHaveBeenCalled();
    expect(services.rows.get("orphan")?.status).toBe("failed");
    expect(services.rows.get("orphan")?.error).toContain("actsAs");
});

test("a persona no card carries is failed unsent too, and named in the reason", async () => {
    // A card renamed on one side only, or a workspace cloned before its personas were committed. The turn would
    // arrive with no account at all, so this is the same failure as naming nobody: said in the queue instead.
    const services = servicesWith(post({ id: "ghost", actsAs: "deleted-card", status: "approved", scheduledAt: NOW - 1 }));
    await createApprovalsExecutor(services).runDue(NOW);
    expect(startTurn).not.toHaveBeenCalled();
    expect(services.rows.get("ghost")?.status).toBe("failed");
    expect(services.rows.get("ghost")?.error).toContain("deleted-card");
});

test("two faces are two turns, each carrying only its own posts", async () => {
    const services = servicesWith(
        post({ id: "a1", actsAs: "alice", status: "approved", scheduledAt: NOW - 1 }),
        post({ id: "b1", actsAs: "bob", status: "approved", scheduledAt: NOW - 1 }),
        post({ id: "a2", actsAs: "alice", status: "approved", scheduledAt: NOW - 1 }),
    );
    await createApprovalsExecutor(services).runDue(NOW);
    expect(startTurn).toHaveBeenCalledTimes(2);
    const byFace = new Map([0, 1].map((call) => [turnOf(call).actsAs, turnOf(call)]));
    expect([...byFace.keys()].toSorted()).toEqual(["alice", "bob"]);
    // Alice's turn carries both of hers and none of Bob's: a turn wears one face, so a batch that mixed them
    // would hand a post to an account that cannot send it.
    expect(byFace.get("alice")?.prompt).toContain("a2.json");
    expect(byFace.get("alice")?.prompt).not.toContain("b1.json");
    expect(byFace.get("bob")?.prompt).toContain("b1.json");
    // Two turns in one pass still need two distinct conversations.
    expect(turnOf(0).conversationId).not.toBe(turnOf(1).conversationId);
});

test("a Discord post needs no persona: the daemon sends it with a stored key, not a browser", async () => {
    const services = servicesWith(
        post({ id: "d", platform: "discord", actsAs: undefined, target: "123456789", status: "approved", scheduledAt: NOW - 1 }),
    );
    await createApprovalsExecutor(services).runDue(NOW);
    expect(sendDiscord).toHaveBeenCalledOnce();
    expect(services.rows.get("d")?.status).toBe("done");
});

test("a Discord post the fast path cannot carry falls back to the turn instead of failing", async () => {
    const services = servicesWith(
        // An attachment needs a multipart upload, and a channel named rather than numbered needs a lookup:
        // both are work only the turn can do.
        post({ id: "media", platform: "discord", target: "123456789", media: ["a.png"], status: "approved", scheduledAt: NOW - 1 }),
        post({ id: "named", platform: "discord", target: "#releases", status: "approved", scheduledAt: NOW - 1 }),
    );
    await createApprovalsExecutor(services).runDue(NOW);
    expect(sendDiscord).not.toHaveBeenCalled();
    expect(startTurn).toHaveBeenCalledOnce();
});

test("a refused Discord post lands as a failure the owner can read, not a silent drop", async () => {
    sendDiscord.mockRejectedValueOnce(new Error("Discord refused the post (HTTP 403): missing access"));
    const services = servicesWith(post({ id: "d", platform: "discord", target: "123456789", status: "approved", scheduledAt: NOW - 1 }));
    await createApprovalsExecutor(services).runDue(NOW);
    expect(services.rows.get("d")).toMatchObject({ status: "failed" });
    expect(services.rows.get("d")?.error).toContain("403");
});

test("an approved action is a turn of its own, briefed from the file and wearing the face it named", async () => {
    const services = servicesWith(action({ id: "hotel", actsAs: "travel" }));
    await createApprovalsExecutor(services).runDue(NOW);
    expect(sendDiscord).not.toHaveBeenCalled();
    expect(startTurn).toHaveBeenCalledOnce();
    expect(turnOf(0).prompt).toContain("hotel.json");
    expect(turnOf(0).prompt).toContain("Book the hotel");
    expect(turnOf(0).actsAs).toBe("travel");
    // The fleet card is named after the thing being done, not "Carry out 1 action".
    expect(turnOf(0).title).toBe("Book the hotel");
    expect(services.rows.get("hotel")?.status).toBe("running");
});

test("an action naming nobody runs with no accounts rather than failing: not every action needs a login", async () => {
    const services = servicesWith(action({ id: "chore", actsAs: undefined, summary: "Delete the stale branches" }));
    await createApprovalsExecutor(services).runDue(NOW);
    expect(startTurn).toHaveBeenCalledOnce();
    expect(turnOf(0).actsAs).toBeUndefined();
    expect(services.rows.get("chore")?.status).toBe("running");
});

test("an action naming a persona nobody carries is failed like a post would be", async () => {
    const services = servicesWith(action({ id: "ghost", actsAs: "nobody" }));
    await createApprovalsExecutor(services).runDue(NOW);
    expect(startTurn).not.toHaveBeenCalled();
    expect(services.rows.get("ghost")).toMatchObject({ status: "failed" });
    expect(services.rows.get("ghost")?.error).toContain("nobody");
});

test("posts and actions due together are separate turns, even under the same face", async () => {
    // Two briefs, two turns: a publish turn is told to post exact words, an action turn to follow instructions,
    // and one prompt cannot honestly say both.
    const services = servicesWith(
        post({ id: "r1", actsAs: "alice", status: "approved", scheduledAt: NOW - 1 }),
        action({ id: "act", actsAs: "alice" }),
    );
    await createApprovalsExecutor(services).runDue(NOW);
    expect(startTurn).toHaveBeenCalledTimes(2);
    expect(turnOf(0).conversationId).not.toBe(turnOf(1).conversationId);
});

test("nothing not yet due is touched", async () => {
    const services = servicesWith(post({ id: "held", status: "approved", scheduledAt: NOW + 30_000 }), post({ id: "waiting", status: "proposed" }));
    await createApprovalsExecutor(services).runDue(NOW);
    expect(startTurn).not.toHaveBeenCalled();
    expect(services.rows.get("held")?.status).toBe("approved");
});

test("two passes at once cannot do the same thing twice", async () => {
    // The failure this guards is unrecoverable: both passes read `approved` before either wrote `running`.
    const services = servicesWith(post({ id: "d", platform: "discord", target: "123456789", status: "approved", scheduledAt: NOW - 1 }));
    const executor = createApprovalsExecutor(services);
    await Promise.all([executor.runDue(NOW), executor.runDue(NOW)]);
    expect(sendDiscord).toHaveBeenCalledOnce();
});
