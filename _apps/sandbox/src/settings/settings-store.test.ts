import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { fileSandboxSettingsStore } from "./settings-store.js";

// A store over a fresh temp path (the .intentic dir doesn't exist yet — the store must create it on write).
const tempStore = () => {
    const path = join(mkdtempSync(join(tmpdir(), "settings-")), ".intentic", "settings.json");
    return { store: fileSandboxSettingsStore(path), path };
};

test("get defaults to searchPastChats off when the file is absent", async () => {
    const { store } = tempStore();
    expect(await store.get()).toEqual({ searchPastChats: false });
});

test("set then get round-trips", async () => {
    const { store } = tempStore();
    await store.set({ searchPastChats: true });
    expect(await store.get()).toEqual({ searchPastChats: true });
    await store.set({ searchPastChats: false });
    expect(await store.get()).toEqual({ searchPastChats: false });
});

test("a corrupt or schema-invalid manifest reads as the defaults rather than throwing", async () => {
    const { store, path } = tempStore();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{ not valid json");
    expect(await store.get()).toEqual({ searchPastChats: false });
    await writeFile(path, JSON.stringify({ searchPastChats: "yes" }));
    expect(await store.get()).toEqual({ searchPastChats: false });
});
