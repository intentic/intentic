import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import {
    activateVersion,
    collectGarbage,
    deactivate,
    engineVersionDir,
    forgetEngineStates,
    installedVersions,
    isQuarantined,
    quarantineVersion,
    readEngineState,
} from "./engine-store.js";

// Pins the state file's meaning: what runs, what going back means, and what this daemon has refused; directories are
// cheap to fake, so these cases are about the file, not npm.

const AT = "2026-09-01T00:00:00.000Z";

const version = (name: string): void => {
    mkdirSync(engineVersionDir("claude", name), { recursive: true });
};

beforeEach(() => {
    process.env["INTENTIC_ENGINES_DIR"] = mkdtempSync(join(tmpdir(), "engine-store-"));
    forgetEngineStates();
});

test("a fresh store runs the image's copy and has nothing to go back to", async () => {
    const state = await readEngineState("claude");
    expect(state.active).toBeUndefined();
    expect(state.previous).toBeUndefined();
    expect(state.quarantined).toEqual([]);
});

// Only a store version replacing another store version sets `previous`; activating over the image leaves it empty,
// since "going back" would mean "stop using the store" anyway.
test("the version a store version replaces becomes the way back", async () => {
    await activateVersion("claude", "0.3.250");
    expect((await readEngineState("claude")).previous).toBeUndefined();

    await activateVersion("claude", "0.3.257");
    const state = await readEngineState("claude");
    expect(state.active).toBe("0.3.257");
    expect(state.previous).toBe("0.3.250");
});

test("re-activating what is already active is not a step back to itself", async () => {
    await activateVersion("claude", "0.3.257");
    await activateVersion("claude", "0.3.257");
    expect((await readEngineState("claude")).previous).toBeUndefined();
});

test("quarantining the running version falls back to the image and says why", async () => {
    await activateVersion("claude", "0.3.257");
    await quarantineVersion("claude", "0.3.257", "would not launch", AT);

    const state = await readEngineState("claude");
    expect(state.active).toBeUndefined();
    expect(isQuarantined(state, "0.3.257")).toBe(true);
    expect(state.quarantined[0]).toEqual({ version: "0.3.257", reason: "would not launch", at: AT });
});

test("activating a version clears the refusal it is under, so an owner can retry a fixed publish", async () => {
    await quarantineVersion("claude", "0.3.257", "did not export query", AT);
    await activateVersion("claude", "0.3.257");
    expect(isQuarantined(await readEngineState("claude"), "0.3.257")).toBe(false);
});

test("the refusal list is bounded, newest first", async () => {
    for (const patch of [1, 2, 3, 4, 5, 6, 7, 8]) {
        await quarantineVersion("claude", `0.3.${patch}`, "no", AT);
    }
    const { quarantined } = await readEngineState("claude");
    expect(quarantined).toHaveLength(6);
    expect(quarantined[0]?.version).toBe("0.3.8");
});

test("going back to the image keeps the store's own history", async () => {
    await activateVersion("claude", "0.3.250");
    await activateVersion("claude", "0.3.257");
    await deactivate("claude");

    const state = await readEngineState("claude");
    expect(state.active).toBeUndefined();
    expect(state.previous).toBe("0.3.250");
});

// GC runs after install and must keep exactly the active/previous pair; a third, older version is the one nobody would
// choose back to.
test("collection keeps what runs and what going back means, and nothing else", async () => {
    for (const name of ["0.3.240", "0.3.250", "0.3.257"]) {
        version(name);
    }
    await activateVersion("claude", "0.3.250");
    await activateVersion("claude", "0.3.257");

    expect(await collectGarbage("claude")).toEqual(["0.3.240"]);
    expect((await installedVersions("claude")).toSorted()).toEqual(["0.3.250", "0.3.257"]);
});
