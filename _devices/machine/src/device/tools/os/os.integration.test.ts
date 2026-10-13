import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceScopes } from "@intentic/sandbox-contract";
import { ScopeError } from "../../policy.js";
import { type OsDeps, osTools, readIntenticOs } from "./os.js";
import type { IcRun } from "../sandboxes.js";

// Whether this machine is Intentic OS is whether its release.json exists, and that alone decides whether the os_* tools
// are offered: anywhere else `ic os` refuses, and a tool that can only fail is a tool a model wastes a call on.

const scopes = (overrides: Partial<DeviceScopes> = {}): DeviceScopes => ({
    shell: "on",
    write: "on",
    screen: "on",
    control: "on",
    sandboxes: "on",
    destructive: "off",
    programs: "off",
    ...overrides,
});

const RELEASE = { name: "Intentic OS", edition: "server", version: "2026.10.13.0", channel: "stable", repository: "ghcr.io/intentic/os" };

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "intentic-os-release-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const asked: string[][] = [];
const deps: OsDeps = {
    ic: async (args): Promise<IcRun> => {
        asked.push([...args]);
        return { code: 0, output: "" };
    },
};

test("no release.json, no os_* tools", () => {
    expect(osTools(join(dir, "release.json"), deps)).toEqual([]);
});

test("on Intentic OS the five tools are offered, and only the status is a read", async () => {
    const release = join(dir, "release.json");
    await writeFile(release, JSON.stringify(RELEASE));
    const tools = osTools(release, deps);
    expect(tools.map((entry) => [entry.name, entry.annotations.readOnlyHint, entry.annotations.destructiveHint])).toEqual([
        ["os_status", true, false],
        ["os_update", false, false],
        ["os_rollback", false, false],
        ["os_reboot", false, false],
        ["os_channel", false, false],
    ]);
    // Every one that reboots says, in its own description, that it takes the caller's sandbox and turn with it.
    for (const name of ["os_update", "os_rollback", "os_reboot"]) {
        expect(tools.find((entry) => entry.name === name)?.description, name).toMatch(/the one you are calling from included/);
    }
});

test("a call is held to its schema and its switch before ic is asked anything", async () => {
    const release = join(dir, "release.json");
    await writeFile(release, JSON.stringify(RELEASE));
    const byName = new Map(osTools(release, deps).map((entry) => [entry.name, entry]));
    asked.length = 0;
    expect(await byName.get("os_channel")?.call({ channel: "nightly" }, scopes())).toMatchObject({ isError: true });
    await expect(byName.get("os_reboot")?.call({}, scopes({ sandboxes: "off" }))).rejects.toThrow(ScopeError);
    await expect(byName.get("os_update")?.call({ op: "apply" }, scopes({ sandboxes: "off" }))).rejects.toThrow(ScopeError);
    expect(asked).toEqual([]);
    await byName.get("os_rollback")?.call({ apply: true }, scopes());
    await byName.get("os_channel")?.call({ channel: "beta" }, scopes());
    expect(asked).toEqual([
        ["os", "rollback", "--apply"],
        ["os", "channel", "beta"],
    ]);
});

test("the facts are read off the same file, and a machine without one reports none", async () => {
    const release = join(dir, "release.json");
    expect(await readIntenticOs(release)).toBeUndefined();
    await writeFile(release, JSON.stringify(RELEASE));
    expect(await readIntenticOs(release)).toEqual({ name: "intentic-os", edition: "server", version: "2026.10.13.0", channel: "stable" });
});
