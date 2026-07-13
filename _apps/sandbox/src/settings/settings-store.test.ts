import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SandboxSettings } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { fileSandboxSettingsStore } from "./settings-store.js";

// A store over a fresh temp path (the .intentic dir doesn't exist yet — the store must create it on write).
const tempStore = () => {
    const path = join(mkdtempSync(join(tmpdir(), "settings-")), ".intentic", "settings.json");
    return { store: fileSandboxSettingsStore(path), path };
};

// Every flag off — the store's DEFAULTS, and the full shape get() must always return.
const ALL_OFF: SandboxSettings = {
    searchPastChats: false,
    stableSystemPrompt: false,
    lspTools: false,
    hashlineEdits: false,
    terseOutput: false,
    outputCleaners: "",
    outputHoldout: 0,
    filterBackend: "native",
};

test("get defaults to every flag off when the file is absent", async () => {
    const { store } = tempStore();
    expect(await store.get()).toEqual(ALL_OFF);
});

test("set then get round-trips the full settings object", async () => {
    const { store } = tempStore();
    const enabled: SandboxSettings = { ...ALL_OFF, searchPastChats: true, hashlineEdits: true };
    await store.set(enabled);
    expect(await store.get()).toEqual(enabled);
    await store.set(ALL_OFF);
    expect(await store.get()).toEqual(ALL_OFF);
});

test("a corrupt or schema-invalid manifest reads as the defaults rather than throwing", async () => {
    const { store, path } = tempStore();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{ not valid json");
    expect(await store.get()).toEqual(ALL_OFF);
    await writeFile(path, JSON.stringify({ searchPastChats: "yes" }));
    expect(await store.get()).toEqual(ALL_OFF);
});

// A manifest written before a flag existed is missing required keys, so safeParse fails and the whole object
// falls back to DEFAULTS (accepted: CLAUDE.md "No migration logic — assume fresh state"). The owner re-saves to
// persist their picks under the new shape.
test("an older manifest missing a flag reads as the defaults", async () => {
    const { store, path } = tempStore();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ searchPastChats: true }));
    expect(await store.get()).toEqual(ALL_OFF);
});
