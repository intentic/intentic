import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileApprovalsStore } from "./approvals-store.js";

test("add mints an id and persists the payload; list is oldest-first; get and remove round-trip", async () => {
    const store = fileApprovalsStore(join(mkdtempSync(join(tmpdir(), "appr-")), "approvals"));
    expect(await store.list()).toEqual([]);

    const first = await store.add({ automationId: "inbox", payload: "ping", createdAt: 1 });
    const second = await store.add({ automationId: "inbox", createdAt: 2 });
    expect(first.id).not.toBe(second.id);

    // Sorted by createdAt ascending; the payload snapshot survives the round-trip, absent when not given.
    expect((await store.list()).map((item) => [item.createdAt, item.payload])).toEqual([
        [1, "ping"],
        [2, undefined],
    ]);
    expect(await store.get(first.id)).toEqual(first);

    expect(await store.remove(first.id)).toBe(true);
    expect(await store.remove(first.id)).toBe(false);
    expect((await store.list()).map((item) => item.id)).toEqual([second.id]);
});
