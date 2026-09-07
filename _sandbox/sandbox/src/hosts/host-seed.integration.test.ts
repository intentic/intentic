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

/* DELETING THE SETUP DEVICE'S CARD HAS TO STICK.
 *
 * A seeded pairing is only burned when a machine agent REDEEMS it, so a setup token whose machine never enrolls
 * — it came up under a different id, it was never started — stays armable for the life of the sandbox. That is
 * deliberate: the pairing lives in memory with a ten-minute TTL, and a machine that boots after the daemon
 * restarts still needs a live token. What it must not do is re-offer the CARD, which is how a device the owner
 * deleted reappeared at every restart with a dead MCP server attached. */

const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

const seed = { token: "from-the-installer", platform: "linux", label: "ada-laptop" };

// A Services exposing only what seedSetupHost and the host handler's apply touch. `seedPairing` always answers
// true, which is exactly the unredeemed-token case this file is about; the entries list is mutable so a test
// can delete the card between boots the way the owner would.
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

    // The owner reads the card, decides they did not want it, and removes it.
    entries.length = 0;

    // The next boot. The pairing is still armed — a machine agent that comes up late can still enroll — and the
    // card stays deleted, which is the whole point, so nothing is offered and the boot log says nothing.
    expect(await seedSetupHost(services, seed)).toEqual({ offered: false, id: "ada-laptop" });
    expect(upserts).toEqual(["ada-laptop"]);
    expect(entries).toEqual([]);
});

/* THE SANDBOX SET UP BEFORE ANY OF THIS EXISTED, which is every sandbox that already carries a setup card. Its
 * id was never recorded, so the first boot on this build has to record the card it FINDS, or the owner's next
 * delete would be undone exactly once more — the one restart that would teach them the delete does not work. */
test("a card left by an earlier build is remembered without being rewritten", async () => {
    const { services, entries, historyRoot, upserts } = tempServices();
    entries.push({ id: "ada-laptop", kind: "host", config: { platform: "linux" } } as unknown as Capability);

    expect(await seedSetupHost(services, seed)).toEqual({ offered: false, id: "ada-laptop" });
    // Left exactly as it was: the owner may have widened or narrowed it since setup.
    expect(upserts).toEqual([]);
    expect(await seededIds(historyRoot)).toEqual(["ada-laptop"]);

    entries.length = 0;
    await seedSetupHost(services, seed);
    expect(entries).toEqual([]);
});

// A setup on an OS the bundled devices extension has no pack for connects nothing, and must not record an id
// either: the card it would have written was never offered, so a later build that grows that pack still can.
test("a platform with no device pack seeds nothing at all", async () => {
    const { services, historyRoot, upserts } = tempServices();

    expect(await seedSetupHost(services, { ...seed, platform: "plan9" })).toEqual({ offered: false, id: "ada-laptop" });
    expect(upserts).toEqual([]);
    await expect(seededIds(historyRoot)).rejects.toThrow();
});
