import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RetentionSettingsSchema, type RetentionSettings } from "@intentic/sandbox-contract/schemas/data-protection";
import { unstubbed } from "@intentic/testing";
import { createLogger } from "../logger.js";
import { removeAgedFiles } from "./aged-files.js";
import { type RetentionDeps, type RetentionPass, runRetentionSweep } from "./retention-sweep.js";

// The sweep deletes for good, so the default must do nothing at all, and each positive setting must reach exactly its
// own kind with the right cut.

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-13T12:00:00Z");

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "intentic-retention-sweep-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

// Every store a sweep could touch throws if reached; a test provides the ones its settings name.
const depsWith = (retention: Partial<RetentionSettings>, provided: Partial<RetentionDeps> = {}): RetentionDeps => ({
    settings: async () => RetentionSettingsSchema.parse(retention),
    now: () => NOW,
    logger,
    transcripts: unstubbed<{ run: RetentionDeps["transcripts"] }>("transcripts", {}).run,
    history: unstubbed<RetentionDeps["history"]>("history", {}),
    vault: unstubbed<RetentionDeps["vault"]>("vault", {}),
    images: unstubbed<RetentionDeps["images"]>("images", {}),
    cacheDirs: unstubbed<{ dirs: RetentionDeps["cacheDirs"] }>("cacheDirs", {}).dirs,
    rawOutputDirs: unstubbed<{ dirs: RetentionDeps["rawOutputDirs"] }>("rawOutputDirs", {}).dirs,
    ...provided,
});

const aged = async (path: string, ageMs: number): Promise<void> => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "x");
    const at = new Date(NOW - ageMs);
    await utimes(path, at, at);
};

test("with every setting at its default the sweep touches nothing", async () => {
    const recorded: RetentionPass[] = [];
    expect(await runRetentionSweep({ ...depsWith({}), record: (pass) => recorded.push(pass) })).toEqual([]);
    expect(recorded).toEqual([]);
});

test("each positive setting reaches its own store with its own cut, and each pass is recorded", async () => {
    const calls: string[] = [];
    const recorded: RetentionPass[] = [];
    const passes = await runRetentionSweep({
        ...depsWith(
            { transcriptDays: 30, restorePointDays: 7, privacyVaultDays: 90 },
            {
                transcripts: async (now, maxAgeMs) => {
                    calls.push(`transcripts ${String(maxAgeMs / DAY)} at ${String(now === NOW)}`);
                    return { deleted: ["a", "b"], failed: 0 };
                },
                history: {
                    prune: async (before) => {
                        calls.push(`restore points ${String((NOW - before) / DAY)}`);
                        return 5;
                    },
                },
                vault: {
                    expire: async (before) => {
                        calls.push(`vault ${String((NOW - before.getTime()) / DAY)}`);
                        return 3;
                    },
                },
                images: { expire: async () => 1 },
            },
        ),
        record: (pass) => recorded.push(pass),
    });
    expect(calls).toEqual(["transcripts 30 at true", "restore points 7", "vault 90"]);
    expect(passes.map(({ kind, days, deleted }) => [kind, days, deleted])).toEqual([
        ["transcripts", 30, 2],
        ["restorePoints", 7, 5],
        ["privacyVault", 90, 4],
    ]);
    expect(passes[0]?.ids).toEqual(["a", "b"]);
    expect(recorded).toEqual(passes);
});

test("a kind not asked for is not run, and one that fails leaves the rest running", async () => {
    const passes = await runRetentionSweep(
        depsWith(
            { transcriptDays: 30, restorePointDays: 7, privacyVaultDays: 90 },
            {
                transcripts: async () => {
                    throw new Error("the database is locked");
                },
                vault: { expire: async () => 2 },
                images: { expire: async () => 0 },
            },
        ),
        ["transcripts", "privacyVault"],
    );
    expect(passes.map(({ kind, deleted }) => [kind, deleted])).toEqual([["privacyVault", 2]]);
});

test("caches and raw output lose the files written before the cut, at any depth, and keep the rest", async () => {
    const cache = join(dir, "cache");
    const logs = join(dir, "raw-output");
    await aged(join(cache, "derived", "docs", "old.pdf.md"), 40 * DAY);
    await aged(join(cache, "derived", "new.docx.md"), DAY);
    await aged(join(logs, "agent-1.log"), 40 * DAY);
    await aged(join(logs, "agent-2.log"), 10 * DAY);
    const passes = await runRetentionSweep(
        depsWith({ cacheDays: 30, rawOutputDays: 5 }, { cacheDirs: async () => [cache, join(dir, "absent")], rawOutputDirs: async () => [logs] }),
    );
    expect(passes.map(({ kind, deleted }) => [kind, deleted])).toEqual([
        ["caches", 1],
        ["rawOutput", 2],
    ]);
    expect(existsSync(join(cache, "derived", "docs"))).toBe(false);
    expect(existsSync(join(cache, "derived", "new.docx.md"))).toBe(true);
    // The folder itself stays for its writers.
    expect(existsSync(logs)).toBe(true);
});

test("removeAgedFiles on a folder that does not exist removes nothing", async () => {
    expect(await removeAgedFiles(join(dir, "nowhere"), NOW)).toBe(0);
});
