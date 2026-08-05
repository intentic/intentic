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

/* A TURN THAT RAN IS THE ONLY EVIDENCE some refusals will ever get. An entitlement refusal — an organization
 * that switched Claude Code off for a seat — outlives every reading that could contradict it: the token keeps
 * authenticating and the plan keeps publishing pools the whole time it refuses everything. So without this, an
 * admin turning access back on would leave the alarm standing for the full week the store remembers it. */
test("settles the account's refusal when a turn finally runs on it", async () => {
    const { store } = tempStore();
    await store.record("claude", refusal({ kind: "entitlement", message: "organization has disabled", account: "claude-1" }));
    await store.clear("claude", "claude-1");
    expect(await store.read()).toEqual({});
});

/* SCOPED TO THE ACCOUNT IT NAMES, which is the whole difficulty: a sandbox holding three Claude accounts runs
 * turns on the healthy ones all day, and letting any of those erase the refused one's record would delete the
 * single fact that stops the picker offering an account that cannot run. The one refusal every success answers
 * is a nameless one — a routed turn, which CLIProxyAPI only refuses once every credential it holds is cooling. */
test("leaves a refusal that names another account alone, and settles one that names nobody", async () => {
    const { store } = tempStore();
    const claude = refusal({ kind: "entitlement", message: "organization has disabled", account: "claude-1" });
    await store.record("claude", claude);
    await store.record("codex", refusal({ message: "all credentials cooling down" }));

    await store.clear("claude", "claude-2");
    await store.clear("claude", undefined);
    await store.clear("gemini", "never-refused");
    await store.clear("codex", "codex-file-3");

    // The named account has served nothing, so its refusal stands; the unattributed one is answered by any turn.
    expect(await store.read()).toEqual({ claude });
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
