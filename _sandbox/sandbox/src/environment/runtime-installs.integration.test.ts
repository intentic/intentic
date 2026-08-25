import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileRuntimeInstallsStore } from "./runtime-installs.js";

const store = () => fileRuntimeInstallsStore(join(mkdtempSync(join(tmpdir(), "runtime-installs-")), "runtime-installs.json"));

test("installs merge by (kind, tool), and sessions count DISTINCT conversations", async () => {
    const ledger = store();
    await ledger.record([{ kind: "cargo", tool: "cargo-xwin" }], "cargo install --locked cargo-xwin", "s1", 1_000);
    await ledger.record([{ kind: "cargo", tool: "cargo-xwin" }], "cargo install cargo-xwin", "s1", 2_000);
    await ledger.record([{ kind: "cargo", tool: "cargo-xwin" }], "cargo install --locked cargo-xwin", "s2", 3_000);
    const { installs } = await ledger.read();
    expect(installs).toHaveLength(1);
    const entry = installs[0]!;
    // A session retrying five times needed the tool once: recurrence is sessions, not commands.
    expect(entry.sessions).toEqual(["s1", "s2"]);
    expect(entry.count).toBe(3);
    expect(entry.firstAt).toBe(1_000);
    expect(entry.lastAt).toBe(3_000);
    // Distinct commands kept as provenance, deduplicated.
    expect(entry.commands).toEqual(["cargo install --locked cargo-xwin", "cargo install cargo-xwin"]);
});

test("the same tool through different ecosystems is two entries, not one", async () => {
    const ledger = store();
    await ledger.record([{ kind: "apt", tool: "ffmpeg" }], "apt-get install -y ffmpeg", "s1", 1_000);
    await ledger.record([{ kind: "other", tool: "ffmpeg" }], "curl https://ffmpeg.org/x | sh", "s1", 2_000);
    expect((await ledger.read()).installs).toHaveLength(2);
});

test("a turn with no conversation id still counts, it just cannot add to recurrence", async () => {
    const ledger = store();
    await ledger.record([{ kind: "apt", tool: "jq" }], "apt-get install -y jq", undefined, 1_000);
    const entry = (await ledger.read()).installs[0]!;
    expect(entry.sessions).toEqual([]);
    expect(entry.count).toBe(1);
});

test("declining tombstones by tool name and leaves the history in place", async () => {
    const ledger = store();
    await ledger.record([{ kind: "apt", tool: "nsis" }], "apt-get install -y nsis", "s1", 1_000);
    await ledger.record([{ kind: "apt", tool: "jq" }], "apt-get install -y jq", "s1", 1_000);
    await ledger.decline(["nsis"], 5_000);
    const { installs } = await ledger.read();
    expect(installs.find((entry) => entry.tool === "nsis")?.declinedAt).toBe(5_000);
    expect(installs.find((entry) => entry.tool === "jq")?.declinedAt).toBeUndefined();
});

test("the drift snapshot rides the same file and survives a re-read", async () => {
    const ledger = store();
    const drift = { bornAt: 100, at: 200, apt: ["ffmpeg"], paths: ["/usr/local/bin/bun"] };
    await ledger.saveDrift(drift);
    expect((await ledger.read()).drift).toEqual(drift);
    // A later record does not clobber it.
    await ledger.record([{ kind: "apt", tool: "jq" }], "apt-get install -y jq", "s1", 300);
    expect((await ledger.read()).drift).toEqual(drift);
});

test("an empty classification records nothing at all", async () => {
    const ledger = store();
    await ledger.record([], "ls -la", "s1", 1_000);
    expect((await ledger.read()).installs).toEqual([]);
});
