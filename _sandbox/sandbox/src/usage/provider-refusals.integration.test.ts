import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderRefusal } from "@intentic/sandbox-contract";
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

// The provider's last refusal moves on to whichever account says no next; a spent allowance is a fact about the account
// that hit it, and must still be on file when another account is refused after it.
test("keeps each account's own limit refusal on file after another account is refused", async () => {
    const { store, path } = tempStore();
    const spent = refusal({ at: Date.now() - 1_000, account: "claude-1", model: "claude-opus-5-5", resetsAt: 1_900_000_000 });
    const later = refusal({ account: "claude-2" });
    const revoked = refusal({ kind: "auth", message: "OAuth token revoked", account: "claude-2" });
    await store.record("claude", spent);
    await store.record("claude", later);
    await store.record("claude", revoked);

    // The wire still carries one refusal per provider, the last.
    expect(await store.read()).toEqual({ claude: revoked });
    const onFile = await fileProviderRefusalStore(path).onFile();
    expect(onFile[`claude`]).toHaveLength(3);
    expect(onFile[`claude`]).toEqual(expect.arrayContaining([revoked, spent, later]));
});

// A turn that runs on the account proves it serves again; one on another account proves nothing about it. Forgetting the
// account (a disconnect) runs the same clear, so its copy goes with it.
test("settles an account's own limit refusal only when that account serves", async () => {
    const { store } = tempStore();
    const spent = refusal({ account: "claude-1" });
    await store.record("claude", spent);
    await store.record("codex", refusal({ message: "all credentials cooling down" }));

    await store.clear("claude", "claude-2");
    await store.clear("claude", undefined);
    expect((await store.onFile())[`claude`]).toEqual([spent, spent]);

    await store.clear("claude", "claude-1");
    expect(await store.onFile()).toEqual({ codex: [expect.objectContaining({ message: "all credentials cooling down" })] });
});

// Sign-in and seat refusals leave marks of their own on the account; only a spent allowance needs a copy, and a refusal
// naming no account has nothing to file it under.
test("keeps no account copy of a sign-in refusal or of one that names no account", async () => {
    const { store } = tempStore();
    await store.record("claude", refusal({ kind: "auth", message: "token revoked", account: "claude-1" }));
    await store.record("codex", refusal({ message: "all credentials cooling down" }));
    expect(Object.values(await store.onFile()).map((refusals) => refusals.length)).toEqual([1, 1]);
});

test("forgets an account's own refusal after a week, as it does the provider's", async () => {
    const { store } = tempStore();
    await store.record("claude", refusal({ at: Date.now() - 8 * DAY, account: "claude-1" }));
    expect(await store.onFile()).toEqual({});
});

// Which account a picker skips changed with each write and nothing said so; another account's refusal replacing the
// provider's slot is the change somebody later has to explain.
test("logs each refusal recorded, whose refusal it superseded, and a settle only when one was on file", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "provider-refusals-")), "history", "provider-refusals.json");
    const lines: { fields: Record<string, unknown>; message: string }[] = [];
    const store = fileProviderRefusalStore(path, { log: (fields, message) => lines.push({ fields, message }) });
    await store.record("claude", refusal({ account: "first", resetsAt: 2_000_000_000 }));
    await store.record("claude", refusal({ account: "second" }));
    // A turn on an account with nothing on file settles nothing, and says nothing.
    await store.clear("claude", "third");
    await store.clear("claude", "second");
    expect(lines.map((line) => line.message)).toEqual([
        "provider refusal: recorded claude limit for first",
        "provider refusal: recorded claude limit for second, superseding first's limit",
        "provider refusal: settled claude limit for second (second served)",
    ]);
    expect(lines[0]?.fields).toMatchObject({ provider: "claude", account: "first", resetsAt: "2033-05-18T03:33:20.000Z" });
    expect(lines[1]?.fields).toMatchObject({ superseded: { account: "first", kind: "limit", keptForAccount: true } });
    expect(lines[2]?.fields).toMatchObject({ settledBy: "second" });
});
