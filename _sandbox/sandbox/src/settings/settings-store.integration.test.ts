import { mkdtempSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { SandboxSettingsSchema, type SandboxSettings } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { ManifestUnreadableError } from "../store/json-file.js";
import { fileSandboxSettingsStore } from "./settings-store.js";

// A store over a fresh temp path (the .intentic dir doesn't exist yet: the store must create it on write).
const tempStore = () => {
    const path = join(mkdtempSync(join(tmpdir(), "settings-")), `${STATE_DIR}`, "config", "settings.json");
    return { store: fileSandboxSettingsStore(path), path };
};

/* The store's defaults, taken FROM the schema rather than transcribed next to it. The copy that used to sit
 * here restated all twenty-two fields and their rationale, so every setting the product gained broke this file
 *: never because the store was wrong, only because the list had moved. What these tests are actually about is
 * the store: absent file ⇒ defaults, and a round trip that changes nothing. */
const DEFAULTS: SandboxSettings = SandboxSettingsSchema.parse({});

test("get returns the defaults when the file is absent", async () => {
    const { store } = tempStore();
    expect(await store.get()).toEqual(DEFAULTS);
});

test("set then get round-trips the full settings object", async () => {
    const { store } = tempStore();
    const enabled: SandboxSettings = { ...DEFAULTS, iqSearch: true, hashlineEdits: true, agentRetentionDays: 0 };
    await store.set(enabled);
    expect(await store.get()).toEqual(enabled);
    await store.set(DEFAULTS);
    expect(await store.get()).toEqual(DEFAULTS);
});

test("a corrupt or schema-invalid manifest reads as the defaults rather than throwing", async () => {
    const { store, path } = tempStore();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{ not valid json");
    expect(await store.get()).toEqual(DEFAULTS);
    await writeFile(path, JSON.stringify({ iqSearch: "yes" }));
    expect(await store.get()).toEqual(DEFAULTS);
});

// The owner's hand-edited manifest: what this build can't parse is theirs to fix; replacing it would lose every pick.
test("set refuses to write over a file this build could not read, and leaves the bytes alone", async () => {
    const { store, path } = tempStore();
    await mkdir(dirname(path), { recursive: true });
    for (const bytes of ["{ not valid json", JSON.stringify({ iqSearch: "yes" })]) {
        await writeFile(path, bytes);
        await expect(store.set(DEFAULTS)).rejects.toBeInstanceOf(ManifestUnreadableError);
        expect(await readFile(path, "utf8")).toBe(bytes);
        expect(await readdir(dirname(path))).toEqual(["settings.json"]);
    }
});

test("load says when the defaults stand in for a file this build could not read", async () => {
    const { store, path } = tempStore();
    expect(await store.load()).toEqual({ settings: DEFAULTS, unreadable: false });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ iqSearch: "yes" }));
    expect(await store.load()).toEqual({ settings: DEFAULTS, unreadable: true });
});

// A manifest written before a flag existed is missing that key, which the schema fills with the flag's own
// default, so the owner's OTHER picks survive the upgrade instead of the whole object being discarded.
test("an older manifest missing a flag keeps its picks and defaults the new one", async () => {
    const { store, path } = tempStore();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ iqSearch: true }));
    expect(await store.get()).toEqual({ ...DEFAULTS, iqSearch: true });
});
