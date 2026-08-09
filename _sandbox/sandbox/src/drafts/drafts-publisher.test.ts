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

const draft = (overrides: Partial<DraftSummary> & { id: string }): DraftSummary => ({
    platform: "reddit",
    content: "hello",
    status: "proposed",
    ...overrides,
});

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
    const prompt = (startTurn.mock.calls[0] as unknown as [unknown, unknown, { prompt: string }])[2].prompt;
    expect(prompt).toContain("r1.json");
    expect(prompt).toContain("r2.json");
    // Marked before the turn starts — a turn that dies must leave a stuck post, never a due one.
    expect(services.rows.get("r1")?.status).toBe("posting");
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
