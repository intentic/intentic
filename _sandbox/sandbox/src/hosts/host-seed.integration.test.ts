import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../workspace/files/workspace-files.js";
import { seedSetupHost } from "./host-seed.js";

// A setup card, once deleted, must never reappear on a later boot, even though the seeded pairing itself stays armed
// until redeemed (so a late-booting machine can still enroll).

const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

const seed = { token: "from-the-installer", platform: "linux", label: "ada-laptop" };

// Services stub covering only what seedSetupHost touches; seedPairing always answers true (the unredeemed-token case),
// entries stays mutable so a test can delete the card between boots.
const tempServices = (): { services: Services; entries: Capability[]; historyRoot: string; upserts: string[] } => {
    const root = mkdtempSync(join(tmpdir(), "host-seed-work-"));
    const historyRoot = mkdtempSync(join(tmpdir(), "host-seed-history-"));
    const entries: Capability[] = [];
    const upserts: string[] = [];
    const services = {
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
        workspace: { root, repos: { intent: join(root, "intent") } },
        files: { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath },
        config: { historyRoot, extensionsDir: EXTENSIONS_DIR },
        capabilities: {
            list: async () => entries,
            upsert: async (capability: Capability) => {
                upserts.push(capability.id);
                entries.push(capability);
            },
        },
        hosts: { seedPairing: async () => true, enrolled: async () => false },
        hostHub: { online: () => false },
    } as unknown as Services;
    return { services, entries, historyRoot, upserts };
};

const seededIds = async (historyRoot: string): Promise<string[]> =>
    JSON.parse(await readFile(join(historyRoot, "host-setup-seeded.json"), "utf8")).ids;

test("the setup device's card is written once and never offered again", async () => {
    const { services, entries, historyRoot, upserts } = tempServices();

    expect(await seedSetupHost(services, seed)).toEqual({ offered: true, id: "ada-laptop" });
    expect(upserts).toEqual(["ada-laptop"]);
    expect(await seededIds(historyRoot)).toEqual(["ada-laptop"]);

    // Owner deletes the card.
    entries.length = 0;

    // Next boot: the pairing is still armed, but the deleted card is not re-offered.
    expect(await seedSetupHost(services, seed)).toEqual({ offered: false, id: "ada-laptop" });
    expect(upserts).toEqual(["ada-laptop"]);
    expect(entries).toEqual([]);
});

// Simulates a sandbox from before id-tracking existed: the card is already there but never recorded, so this boot must
// adopt it rather than rewrite it.
test("a card left by an earlier build is remembered without being rewritten", async () => {
    const { services, entries, historyRoot, upserts } = tempServices();
    entries.push({ id: "ada-laptop", kind: "host", config: { platform: "linux" } } as unknown as Capability);

    expect(await seedSetupHost(services, seed)).toEqual({ offered: false, id: "ada-laptop" });
    expect(upserts).toEqual([]);
    expect(await seededIds(historyRoot)).toEqual(["ada-laptop"]);

    entries.length = 0;
    await seedSetupHost(services, seed);
    expect(entries).toEqual([]);
});

// Records no id either: a later build that adds a device pack for this platform must still be able to offer the card.
test("a platform with no device pack seeds nothing at all", async () => {
    const { services, historyRoot, upserts } = tempServices();

    expect(await seedSetupHost(services, { ...seed, platform: "plan9" })).toEqual({ offered: false, id: "ada-laptop" });
    expect(upserts).toEqual([]);
    await expect(seededIds(historyRoot)).rejects.toThrow();
});
