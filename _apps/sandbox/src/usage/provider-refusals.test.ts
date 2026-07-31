import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderRefusal } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { fileProviderRefusalStore } from "./provider-refusals.js";

// A store over a fresh temp path whose parent dir doesn't exist yet — the store must create it on write.
const tempStore = () => {
    const path = join(mkdtempSync(join(tmpdir(), "provider-refusals-")), "history", "provider-refusals.json");
    return { store: fileProviderRefusalStore(path), path };
};

const DAY = 24 * 60 * 60_000;
const refusal = (over: Partial<ProviderRefusal> = {}): ProviderRefusal => ({
    at: Date.now(),
    kind: "limit",
    message: "You've reached your usage limit for this billing cycle.",
    ...over,
});

test("read is empty when nothing has ever been refused", async () => {
    const { store } = tempStore();
    expect(await store.read()).toEqual({});
});

// The reason this is a file rather than a variable: a refusal that arrives at 4am against an automation is
// exactly the one nobody was attached for, and it has to still be there when somebody opens the tab.
test("a recorded refusal survives a fresh store over the same path", async () => {
    const { store, path } = tempStore();
    const kimi = refusal();
    await store.record("kimi", kimi);
    expect(await fileProviderRefusalStore(path).read()).toEqual({ kimi });
});

test("each provider keeps its own last refusal, and the newest one wins", async () => {
    const { store } = tempStore();
    await store.record("kimi", refusal({ at: 1_000, message: "older" }));
    await store.record("claude", refusal({ kind: "auth", message: "token revoked", account: "claude-1" }));
    await store.record("kimi", refusal({ message: "newer" }));
    const read = await store.read();
    expect(read[`kimi`]?.message).toBe("newer");
    expect(read[`claude`]?.account).toBe("claude-1");
});

/* Past a week a refusal describes a window that has certainly reopened, so serving it would put a stale alarm
 * under a live meter. Forgotten on READ, because a daemon that never refuses again writes nothing that could
 * prune it — the file keeps the row and the store simply stops reporting it. */
test("forgets a refusal old enough to describe a window that has since reopened", async () => {
    const { store } = tempStore();
    await store.record("kimi", refusal({ at: Date.now() - 8 * DAY }));
    await store.record("codex", refusal({ at: Date.now() - 6 * DAY }));
    expect(Object.keys(await store.read())).toEqual(["codex"]);
});
