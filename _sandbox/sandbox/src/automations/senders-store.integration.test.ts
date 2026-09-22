import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { fileSendersStore, SENDERS_KEPT } from "./senders-store.js";

const store = () => fileSendersStore(join(mkdtempSync(join(tmpdir(), "senders-")), "senders.json"));

test("records who wrote, per provider, newest first, counting their messages", async () => {
    const senders = store();
    await senders.record("discord", { id: "u1", name: "alice" }, 1_000);
    await senders.record("discord", { id: "u2", name: "bob", groups: ["r-staff"] }, 2_000);
    await senders.record("discord", { id: "u1", name: "alice (renamed)" }, 3_000);
    await senders.record("slack", { id: "u1", name: "not the same alice" }, 4_000);

    expect(await senders.list("discord")).toEqual([
        { id: "u1", name: "alice (renamed)", firstSeenAt: 1_000, lastSeenAt: 3_000, messages: 2 },
        { id: "u2", name: "bob", groups: ["r-staff"], firstSeenAt: 2_000, lastSeenAt: 2_000, messages: 1 },
    ]);
    // A Discord id and a Slack id that happen to share a string are two people.
    expect(await senders.list("slack")).toEqual([{ id: "u1", name: "not the same alice", firstSeenAt: 4_000, lastSeenAt: 4_000, messages: 1 }]);
    expect(await senders.list("telegram")).toEqual([]);
});

test("a roster over the cap drops whoever was heard from least recently", async () => {
    const senders = store();
    for (let i = 0; i < SENDERS_KEPT + 1; i += 1) {
        await senders.record("discord", { id: `u${i}`, name: `user ${i}` }, i);
    }
    const kept = await senders.list("discord");
    expect(kept).toHaveLength(SENDERS_KEPT);
    expect(kept.some((seen) => seen.id === "u0")).toBe(false);
    expect(kept[0]?.id).toBe(`u${SENDERS_KEPT}`);
});
