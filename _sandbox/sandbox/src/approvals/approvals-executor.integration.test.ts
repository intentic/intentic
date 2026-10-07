import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionApprovalSummary, ApprovalSummary, PostApprovalSummary } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { recordApproval } from "./approval-decisions.js";

// Tests when the executor wakes and which door each item goes through, both decided from the queue on disk, and that
// an item runs only on the owner's yes as the approve route records it. The fake store below behaves like the real one
// (read, write, read back), the ledger of yeses is the real one on a temp history volume; only the two doors themselves
// are stubbed.

const startTurn = jest.fn(async () => undefined);
// The gateway's /deliver door: the one network hop a direct post makes. Whether a post can go the fast way, and what
// the daemon refuses before asking, are themselves under test.
const sendDiscord = jest.fn(async (..._args: unknown[]): Promise<{ url?: string } | undefined> => ({ url: "https://discord.com/channels/1/2/3" }));

jest.mock("../seams/runtime-feed.js", () => ({ publishRuntimeChange: jest.fn() }));
jest.mock("../extensions/listener/listener-deliver.js", () => ({
    deliverThroughGateway: (...args: unknown[]) => sendDiscord(...args),
}));

const { createApprovalsExecutor, nextDueAt } = await import("./approvals-executor.js");

const NOW = 1_700_000_000_000;

// `actsAs` defaults on since a browser post with no persona is its own failure case, tested separately below.
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

// The argument to a TurnStarter start: the whole request.
const turnOf = (call: number): { prompt: string; actsAs?: string; conversationId: string; title?: string } =>
    (startTurn.mock.calls[call] as unknown as [{ prompt: string; actsAs?: string; conversationId: string; title?: string }])[0];

// A store that behaves like the file one: upsert replaces by id, list returns what is there now. Every item seeded as
// approved was approved the way the owner approves, its yes recorded as the route records it; `rows` is the workspace
// directory a turn writes behind the owner's back.
const servicesWith = async (...seed: ApprovalSummary[]) => {
    const rows = new Map(seed.map((entry) => [entry.id, entry]));
    const started: { prompt: string }[] = [];
    const roots = { historyRoot: mkdtempSync(join(tmpdir(), "approvals-history-")), workspaceRoot: mkdtempSync(join(tmpdir(), "approvals-work-")) };
    await Promise.all(seed.filter((entry) => entry.status === "approved").map((entry) => recordApproval(roots, entry, "owner@example.com")));
    return {
        config: { historyRoot: roots.historyRoot },
        workspace: { root: roots.workspaceRoot },
        roots,
        approvals: {
            list: async () => ({ approvals: [...rows.values()], invalid: [] }),
            upsert: async (entry: ApprovalSummary) => void rows.set(entry.id, entry),
            remove: async (id: string) => rows.delete(id),
        },
        // The cast the executor checks `actsAs` against: the default face plus the ones the multi-persona tests use.
        personas: {
            list: async () => [
                { id: "poster", capabilities: [] },
                { id: "alice", capabilities: [] },
                { id: "bob", capabilities: [] },
                { id: "travel", capabilities: [] },
            ],
        },
        logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
        // The detached start is the one door a turn goes through; `started` keeps this suite's own, since an earlier
        // test's executor re-arms on the real clock and may start a turn of its own while a later test runs.
        turns: {
            start: (...args: unknown[]) => {
                started.push(args[0] as { prompt: string });
                return startTurn(...(args as []));
            },
        },
        rows,
        started,
    } as unknown as Services & {
        rows: Map<string, ApprovalSummary>;
        roots: { historyRoot: string; workspaceRoot: string };
        started: { prompt: string }[];
    };
};

// What this suite's services sent through the Discord gateway, whatever another test's executor sends meanwhile.
const sentBy = (services: object): unknown[][] => sendDiscord.mock.calls.filter(([via]) => via === services);

beforeEach(() => {
    startTurn.mockClear();
    sendDiscord.mockClear();
});

test("the next wake is the soonest approved item, and there is none when nothing is approved", () => {
    expect(nextDueAt([post({ id: "a" }), post({ id: "b", status: "done" })], NOW)).toBeUndefined();
    expect(nextDueAt([post({ id: "a", status: "approved", scheduledAt: NOW + 5_000 })], NOW)).toBe(NOW + 5_000);
    // Soonest wins; anything already past due answers `now`, so a stale queue fires on the next arm, not later.
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
    const services = await servicesWith(post({ id: "d", platform: "discord", target: "123456789", status: "approved", scheduledAt: NOW - 1 }));
    await createApprovalsExecutor(services).runDue(NOW);
    expect(sendDiscord).toHaveBeenCalledTimes(1);
    expect(startTurn).not.toHaveBeenCalled();
    expect(services.rows.get("d")).toMatchObject({ status: "done", result: "https://discord.com/channels/1/2/3" });
});

test("a browser-only platform gets one turn for the whole batch", async () => {
    const services = await servicesWith(
        post({ id: "r1", status: "approved", scheduledAt: NOW - 1 }),
        post({ id: "r2", status: "approved", scheduledAt: NOW - 1 }),
    );
    await createApprovalsExecutor(services).runDue(NOW);
    // One turn, not one per post: what a turn costs is that it exists.
    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(turnOf(0).prompt).toContain("r1.json");
    expect(turnOf(0).prompt).toContain("r2.json");
    expect(turnOf(0).prompt).toContain(".intentic/config/approvals/");
    // It wakes wearing the face the posts named; unpinned, it would be denied the Reddit login these posts need.
    expect(turnOf(0).actsAs).toBe("poster");
    // Marked before the turn starts: a turn that dies must leave a stuck item, never a due one.
    expect(services.rows.get("r1")?.status).toBe("running");
});

test("a browser post that names no persona is failed unsent, with a reason the owner can act on", async () => {
    const services = await servicesWith(post({ id: "orphan", actsAs: undefined, status: "approved", scheduledAt: NOW - 1 }));
    await createApprovalsExecutor(services).runDue(NOW);
    // No turn at all: waking one with no account would report a missing login, the wrong message to show the owner.
    expect(startTurn).not.toHaveBeenCalled();
    expect(services.rows.get("orphan")?.status).toBe("failed");
    expect(services.rows.get("orphan")?.error).toContain("actsAs");
});

test("a persona no card carries is failed unsent too, and named in the reason", async () => {
    // A card renamed on one side, or cloned before personas committed, is the same failure as naming nobody.
    const services = await servicesWith(post({ id: "ghost", actsAs: "deleted-card", status: "approved", scheduledAt: NOW - 1 }));
    await createApprovalsExecutor(services).runDue(NOW);
    expect(startTurn).not.toHaveBeenCalled();
    expect(services.rows.get("ghost")?.status).toBe("failed");
    expect(services.rows.get("ghost")?.error).toContain("deleted-card");
});

test("two faces are two turns, each carrying only its own posts", async () => {
    const services = await servicesWith(
        post({ id: "a1", actsAs: "alice", status: "approved", scheduledAt: NOW - 1 }),
        post({ id: "b1", actsAs: "bob", status: "approved", scheduledAt: NOW - 1 }),
        post({ id: "a2", actsAs: "alice", status: "approved", scheduledAt: NOW - 1 }),
    );
    await createApprovalsExecutor(services).runDue(NOW);
    expect(startTurn).toHaveBeenCalledTimes(2);
    const byFace = new Map([0, 1].map((call) => [turnOf(call).actsAs, turnOf(call)]));
    expect([...byFace.keys()].toSorted()).toEqual(["alice", "bob"]);
    // A turn wears one face: mixing posts across faces would hand one to an account that cannot send it.
    expect(byFace.get("alice")?.prompt).toContain("a2.json");
    expect(byFace.get("alice")?.prompt).not.toContain("b1.json");
    expect(byFace.get("bob")?.prompt).toContain("b1.json");
    // Two turns in one pass still need two distinct conversations.
    expect(turnOf(0).conversationId).not.toBe(turnOf(1).conversationId);
});

test("a Discord post needs no persona: the daemon sends it through the gateway's bot, not a browser", async () => {
    const services = await servicesWith(
        post({ id: "d", platform: "discord", actsAs: undefined, target: "123456789", status: "approved", scheduledAt: NOW - 1 }),
    );
    await createApprovalsExecutor(services).runDue(NOW);
    expect(sendDiscord).toHaveBeenCalledTimes(1);
    expect(services.rows.get("d")?.status).toBe("done");
});

test("a Discord post the fast path cannot carry falls back to the turn instead of failing", async () => {
    const services = await servicesWith(
        // An attachment needs a multipart upload; a named (not numbered) channel needs a lookup: turn-only work.
        post({ id: "media", platform: "discord", target: "123456789", media: ["a.png"], status: "approved", scheduledAt: NOW - 1 }),
        post({ id: "named", platform: "discord", target: "#releases", status: "approved", scheduledAt: NOW - 1 }),
    );
    await createApprovalsExecutor(services).runDue(NOW);
    expect(sendDiscord).not.toHaveBeenCalled();
    expect(startTurn).toHaveBeenCalledTimes(1);
});

test("a refused Discord post lands as a failure the owner can read, not a silent drop", async () => {
    sendDiscord.mockRejectedValueOnce(new Error("Discord refused the message (HTTP 403): Missing Access"));
    const services = await servicesWith(post({ id: "d", platform: "discord", target: "123456789", status: "approved", scheduledAt: NOW - 1 }));
    await createApprovalsExecutor(services).runDue(NOW);
    expect(services.rows.get("d")).toMatchObject({ status: "failed", error: "Discord refused the message (HTTP 403): Missing Access" });
});

test("a Discord post goes to the discord gateway's channel as written, and its link is what the posted row shows", async () => {
    const services = await servicesWith(
        post({ id: "d", platform: "Discord", target: "123456789", content: "v2 is out", status: "approved", scheduledAt: NOW - 1 }),
    );
    await createApprovalsExecutor(services).runDue(NOW);
    expect(sendDiscord.mock.calls[0]?.slice(1)).toEqual(["discord", "123456789", "v2 is out"]);
    expect(services.rows.get("d")).toMatchObject({ status: "done", result: "https://discord.com/channels/1/2/3" });
});

test("with no Discord gateway listening, the post fails saying there is no bot to post as", async () => {
    sendDiscord.mockResolvedValueOnce(undefined);
    const services = await servicesWith(post({ id: "d", platform: "discord", target: "123456789", status: "approved", scheduledAt: NOW - 1 }));
    await createApprovalsExecutor(services).runDue(NOW);
    expect(services.rows.get("d")).toMatchObject({ status: "failed", error: "Discord isn't connected in this workspace, so there is no bot to post as." });
});

test("a post past Discord's ceiling is refused before it is sent, not split into several messages", async () => {
    const services = await servicesWith(
        post({ id: "d", platform: "discord", target: "123456789", content: "a".repeat(2_001), status: "approved", scheduledAt: NOW - 1 }),
    );
    await createApprovalsExecutor(services).runDue(NOW);
    expect(sendDiscord).not.toHaveBeenCalled();
    expect(services.rows.get("d")).toMatchObject({ status: "failed", error: "Discord caps a message at 2,000 characters and this one is 2,001." });
});

test("a gateway that posted but named no link still settles the post as done", async () => {
    sendDiscord.mockResolvedValueOnce({});
    const services = await servicesWith(post({ id: "d", platform: "discord", target: "123456789", status: "approved", scheduledAt: NOW - 1 }));
    await createApprovalsExecutor(services).runDue(NOW);
    expect(services.rows.get("d")?.status).toBe("done");
    expect(services.rows.get("d")).not.toHaveProperty("result");
});

test("an approved action is a turn of its own, briefed from the file and wearing the face it named", async () => {
    const services = await servicesWith(action({ id: "hotel", actsAs: "travel" }));
    await createApprovalsExecutor(services).runDue(NOW);
    expect(sendDiscord).not.toHaveBeenCalled();
    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(turnOf(0).prompt).toContain("hotel.json");
    expect(turnOf(0).prompt).toContain("Book the hotel");
    expect(turnOf(0).actsAs).toBe("travel");
    // The fleet card is named after the thing being done, not "Carry out 1 action".
    expect(turnOf(0).title).toBe("Book the hotel");
    expect(services.rows.get("hotel")?.status).toBe("running");
});

test("an action naming nobody runs with no accounts rather than failing: not every action needs a login", async () => {
    const services = await servicesWith(action({ id: "chore", actsAs: undefined, summary: "Delete the stale branches" }));
    await createApprovalsExecutor(services).runDue(NOW);
    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(turnOf(0).actsAs).toBeUndefined();
    expect(services.rows.get("chore")?.status).toBe("running");
});

test("an action naming a persona nobody carries is failed like a post would be", async () => {
    const services = await servicesWith(action({ id: "ghost", actsAs: "nobody" }));
    await createApprovalsExecutor(services).runDue(NOW);
    expect(startTurn).not.toHaveBeenCalled();
    expect(services.rows.get("ghost")).toMatchObject({ status: "failed" });
    expect(services.rows.get("ghost")?.error).toContain("nobody");
});

test("posts and actions due together are separate turns, even under the same face", async () => {
    // Two briefs, two turns: a publish turn posts exact words, an action turn follows instructions.
    const services = await servicesWith(
        post({ id: "r1", actsAs: "alice", status: "approved", scheduledAt: NOW - 1 }),
        action({ id: "act", actsAs: "alice" }),
    );
    await createApprovalsExecutor(services).runDue(NOW);
    expect(startTurn).toHaveBeenCalledTimes(2);
    expect(turnOf(0).conversationId).not.toBe(turnOf(1).conversationId);
});

test("nothing not yet due is touched", async () => {
    const services = await servicesWith(
        post({ id: "held", status: "approved", scheduledAt: NOW + 30_000 }),
        post({ id: "waiting", status: "proposed" }),
    );
    await createApprovalsExecutor(services).runDue(NOW);
    expect(startTurn).not.toHaveBeenCalled();
    expect(services.rows.get("held")?.status).toBe("approved");
});

test("two passes at once cannot do the same thing twice", async () => {
    // The failure this guards is unrecoverable: both passes read `approved` before either wrote `running`.
    const services = await servicesWith(post({ id: "d", platform: "discord", target: "123456789", status: "approved", scheduledAt: NOW - 1 }));
    const executor = createApprovalsExecutor(services);
    await Promise.all([executor.runDue(NOW), executor.runDue(NOW)]);
    expect(sendDiscord).toHaveBeenCalledTimes(1);
});

test("an item a turn marked approved itself is failed unsent, saying the yes is the owner's to give", async () => {
    const services = await servicesWith();
    // Written straight into the queue's directory, as a turn can: no yes was ever recorded for it.
    services.rows.set("self", post({ id: "self", platform: "discord", target: "555555555555", status: "approved", scheduledAt: NOW - 1 }));
    services.rows.set("errand", action({ id: "errand" }));
    await createApprovalsExecutor(services).runDue(NOW);
    expect(sentBy(services)).toEqual([]);
    expect(services.started).toEqual([]);
    expect(services.rows.get("self")).toMatchObject({ status: "failed" });
    expect(services.rows.get("self")?.error).toContain("never by writing");
    expect(services.rows.get("errand")).toMatchObject({ status: "failed" });
});

test("an item changed after the owner approved it is not carried out, whatever changed", async () => {
    const approved = action({ id: "hotel", actsAs: "travel" });
    const posted = post({ id: "d", platform: "discord", target: "555555555555", status: "approved", scheduledAt: NOW - 1 });
    const later = post({ id: "later", status: "approved", scheduledAt: NOW - 1 });
    const services = await servicesWith(approved, posted, later);
    // The instructions, the channel, and the moment it goes: each is part of what the yes covered.
    services.rows.set("hotel", { ...approved, instructions: "Book the presidential suite instead." });
    services.rows.set("d", { ...posted, target: "987654321098" });
    services.rows.set("later", { ...later, scheduledAt: NOW - 2 });
    await createApprovalsExecutor(services).runDue(NOW);
    expect(sentBy(services)).toEqual([]);
    expect(services.started).toEqual([]);
    for (const id of ["hotel", "d", "later"]) {
        expect(services.rows.get(id)).toMatchObject({ status: "failed" });
        expect(services.rows.get(id)?.error).toContain("changed after it was approved");
    }
});

test("a picture swapped after the yes is a change too: the yes covers the bytes the post attaches", async () => {
    const chart = "posts/chart.png";
    const swapped = post({ id: "media", media: [chart], status: "approved", scheduledAt: NOW - 1 });
    const kept = post({ id: "kept", media: [chart.replace("chart", "logo")], status: "approved", scheduledAt: NOW - 1 });
    const services = await servicesWith();
    await mkdir(join(services.roots.workspaceRoot, "posts"), { recursive: true });
    await writeFile(join(services.roots.workspaceRoot, chart), "the chart the owner saw");
    await writeFile(join(services.roots.workspaceRoot, chart.replace("chart", "logo")), "the logo");
    for (const item of [swapped, kept]) {
        await recordApproval(services.roots, item, "owner@example.com");
        services.rows.set(item.id, item);
    }
    await writeFile(join(services.roots.workspaceRoot, chart), "something else");
    await createApprovalsExecutor(services).runDue(NOW);
    expect(services.rows.get("media")).toMatchObject({ status: "failed" });
    expect(services.started.map(({ prompt }) => [prompt.includes("kept.json"), prompt.includes("media.json")])).toEqual([[true, false]]);
});

test("a yes runs its item once: put back to approved by hand afterwards, it is failed rather than done again", async () => {
    const services = await servicesWith(post({ id: "d", platform: "discord", target: "555555555555", status: "approved", scheduledAt: NOW - 1 }));
    const executor = createApprovalsExecutor(services);
    await executor.runDue(NOW);
    expect(services.rows.get("d")?.status).toBe("done");

    const done = services.rows.get("d");
    services.rows.set("d", { ...(done as PostApprovalSummary), status: "approved" });
    await executor.runDue(NOW);
    expect(sentBy(services)).toHaveLength(1);
    expect(services.rows.get("d")).toMatchObject({ status: "failed" });
});
