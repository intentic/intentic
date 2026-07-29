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

// The store's DEFAULTS, and the full shape get() must always return. Every agent-behaviour flag is opt-in and
// so defaults off; `agentRetentionDays` is the exception and defaults ON, because the lane it governs has no
// exit of its own — left alone it grows a worktree checkout per agent for the life of the sandbox.
const DEFAULTS: SandboxSettings = {
    stableSystemPrompt: false,
    skills: [],
    hashlineEdits: false,
    terseOutput: false,
    // The steer's measurement control is off by default: a holdout spends the very tokens it measures, so it
    // is something the owner opts into once, not a cost every sandbox pays to produce a number nobody asked for.
    terseHoldout: 0,
    iqSearch: false,
    outputCleaners: "off",
    outputHoldout: 0,
    filterBackend: "native",
    // The default base is Intentic's own prompt; the text field is only read under "custom".
    systemPromptMode: "intentic",
    systemPrompt: "",
    // Empty means Auto, not "none": the quick model is resolved from the connected accounts each time it is
    // read, so there is no id for a fresh sandbox to store.
    quickModel: "",
    agentRetentionDays: 3,
    // The other exception: auto-land defaults ON because it is the historical behaviour — defaulting off
    // would silently hold every existing sandbox's finished work on branches nobody is watching.
    autoLand: true,
    autoResumeOnLimit: false,
    // And the third: a provider outage is the provider's failure, not a budget the user chose to spend.
    resumeAfterOutage: true,
};

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

// A manifest written before a flag existed is missing that key, which the schema fills with the flag's own
// default — so the owner's OTHER picks survive the upgrade instead of the whole object being discarded.
test("an older manifest missing a flag keeps its picks and defaults the new one", async () => {
    const { store, path } = tempStore();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ iqSearch: true }));
    expect(await store.get()).toEqual({ ...DEFAULTS, iqSearch: true });
});
