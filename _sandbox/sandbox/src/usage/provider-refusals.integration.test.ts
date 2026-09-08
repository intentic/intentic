import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderRefusal } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { fileProviderRefusalStore } from "./provider-refusals.js";

// Path's parent directory doesn't exist yet; the store must create it on write.
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

// A refusal at 4am against an automation is exactly the one nobody's watching; it must still be there when somebody
// opens the tab.
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

// An entitlement refusal (a seat with Claude Code switched off) outlives every reading that could contradict it, since
// the token keeps authenticating and pools keep publishing regardless; only a turn that runs proves it's over.
test("settles the account's refusal when a turn finally runs on it", async () => {
    const { store } = tempStore();
    await store.record("claude", refusal({ kind: "entitlement", message: "organization has disabled", account: "claude-1" }));
    await store.clear("claude", "claude-1");
    expect(await store.read()).toEqual({});
});

// Scoped to the account it names: another healthy account succeeding must not erase this one's refusal. An unattributed
// refusal (CLIProxyAPI cooling every credential) is the one any success settles.
test("leaves a refusal that names another account alone, and settles one that names nobody", async () => {
    const { store } = tempStore();
    const claude = refusal({ kind: "entitlement", message: "organization has disabled", account: "claude-1" });
    await store.record("claude", claude);
    await store.record("codex", refusal({ message: "all credentials cooling down" }));

    await store.clear("claude", "claude-2");
    await store.clear("claude", undefined);
    await store.clear("gemini", "never-refused");
    await store.clear("codex", "codex-file-3");

    // Named account has served nothing, so its refusal stands; the unattributed one is settled by any turn.
    expect(await store.read()).toEqual({ claude });
});

// Past a week a refusal's window has certainly reopened; serving it would put a stale alarm under a live meter.
// Forgotten on read, since a daemon that never refuses again writes nothing to prune it.
test("forgets a refusal old enough to describe a window that has since reopened", async () => {
    const { store } = tempStore();
    await store.record("kimi", refusal({ at: Date.now() - 8 * DAY }));
    await store.record("codex", refusal({ at: Date.now() - 6 * DAY }));
    expect(Object.keys(await store.read())).toEqual(["codex"]);
});
