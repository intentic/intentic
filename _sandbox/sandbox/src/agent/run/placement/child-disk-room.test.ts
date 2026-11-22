import { createHoldingsIndex, type Share } from "../../../conversations/actor/conversation-holdings.js";
import { ROSTER } from "../../../conversations/actor/subagent-roster.js";
import { CheckoutSpaceRefused } from "../../../system/resources/storage/checkout-space.js";
import { composeWithChildDiskRoom, resetChildDiskRoomLineForTest, stopChildDiskRoomWait } from "./child-disk-room.js";

const shares = new Map<string, Share>();
const holdings = createHoldingsIndex((holder, create) => {
    let share = shares.get(holder);
    if (share === undefined && create) {
        share = new Map();
        shares.set(holder, share);
    }
    return share;
}).holdings;

const servicesFor = (id: string) => {
    const row = { id, kind: "spawned", conversationId: id, status: "pending", startedAt: 0, endedAt: undefined, activityAt: 0, summary: "" };
    // SAFETY: this row supplies every field the disk-room seam reads or writes; other roster state is irrelevant here.
    holdings(ROSTER).hold("parent", id, row as never);
    const frames: unknown[] = [];
    let resolveUpdate!: () => void;
    const updated = new Promise<void>((resolve) => {
        resolveUpdate = resolve;
    });
    const fixture = {
        conversations: {
            holdings,
            send: async (_conversationId: string, event: unknown) => {
                frames.push(event);
                resolveUpdate();
            },
        },
    };
    // SAFETY: composeWithChildDiskRoom exercises only holdings and send from this service seam.
    const services = fixture as never;
    return { services, row, frames, updated };
};

afterEach(() => {
    resetChildDiskRoomLineForTest();
    holdings(ROSTER).clear();
    shares.clear();
});

const refusal = (): CheckoutSpaceRefused => new CheckoutSpaceRefused(1, 2);

test("a spawned child waits in the disk line, updates its row, and retries when it reaches the front", async () => {
    const id = "sub-disk-wait";
    const { services, row, frames, updated } = servicesFor(id);
    let attempts = 0;
    const result = composeWithChildDiskRoom(
        services,
        id,
        undefined,
        async () => {
            attempts += 1;
            if (attempts === 1) {
                throw refusal();
            }
            return "composed";
        },
        { retryMs: 20, now: () => 1_000 },
    );

    // The first refusal is visible before the timed retry begins.
    await updated;
    expect(row.status).toBe("pending");
    expect(row.summary).toContain("Waiting for disk space");
    expect(frames).toContainEqual({ kind: "frame", frame: { kind: "subagent_update", id, status: "pending", summary: row.summary } });
    await expect(result).resolves.toBe("composed");
    expect(attempts).toBe(2);
    expect(row.status).toBe("running");
    expect(row.summary).toBe("");
});

test("a cancelled child leaves the disk line without another checkout attempt", async () => {
    const id = "sub-disk-cancel";
    const { services, row, updated } = servicesFor(id);
    let attempts = 0;
    const result = composeWithChildDiskRoom(
        services,
        id,
        undefined,
        async () => {
            attempts += 1;
            throw refusal();
        },
        { retryMs: 60_000 },
    );
    await updated;
    stopChildDiskRoomWait(id);
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toBe(1);
    expect(row.status).toBe("pending");
});
