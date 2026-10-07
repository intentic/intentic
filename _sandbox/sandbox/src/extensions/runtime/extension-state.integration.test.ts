import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathExists } from "@intentic/base/fs";
import { extensionStateDir, legacyExtensionStateDir } from "@intentic/sandbox-contract";
import { prepareExtensionDirs } from "./extension-state.js";

// The directories an extension's own code keeps things in: made before its code runs, and for a first-party extension
// that kept its state under its bare name, moved to its identity once.

test("a first-party extension's name-keyed directory moves to its identity once, and nobody else's is touched", async () => {
    const root = mkdtempSync(join(tmpdir(), "extension-state-"));
    const legacy = join(root, legacyExtensionStateDir("imap"));
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "acct.json"), "{}");
    await writeFile(join(legacy, "gateway.url"), "http://127.0.0.1:1");

    const dirs = await prepareExtensionDirs(root, { publisher: "intentic", name: "imap" });
    expect(dirs.stateDir).toBe(join(root, extensionStateDir("intentic.imap")));
    expect(await pathExists(join(dirs.stateDir, "acct.json"))).toBe(true);
    // The control address it published there is stale once moved; the gateway writes it where it lives now.
    expect(await pathExists(join(dirs.stateDir, "gateway.url"))).toBe(false);
    expect(await pathExists(legacy)).toBe(false);
    expect(await pathExists(dirs.cacheDir)).toBe(true);

    // A later run finds both and merges nothing.
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "acct.json"), "stale");
    await prepareExtensionDirs(root, { publisher: "intentic", name: "imap" });
    expect(await pathExists(legacy)).toBe(true);

    // Another publisher's extension of the same name never adopts it.
    const other = join(root, legacyExtensionStateDir("tool"));
    await mkdir(other, { recursive: true });
    await prepareExtensionDirs(root, { publisher: "acme", name: "tool" });
    expect(await pathExists(other)).toBe(true);
});
