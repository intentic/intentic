import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { DeviceFactsSchema } from "./hosts.js";
import {
    icOsChannelArgs,
    icOsRebootArgs,
    icOsRollbackArgs,
    icOsStatusArgs,
    icOsUpdateArgs,
    type IntenticOsChannel,
    intenticOsFactsFrom,
    IntenticOsReleaseSchema,
    IntenticOsStatusSchema,
    IntenticOsUpdateCheckSchema,
    isIntenticOs,
} from "./intentic-os.js";

// What `ic os` answers, as examples: golden/intentic-os.json holds a release.json, the shapes `ic os status --json`
// gives (a quiet box, one with an update staged and a failed boot, one whose bootc said little) and both answers of
// `ic os update --check --json`. This is the TS half: what ic gives is what the contract reads, to the field.

// SAFETY: the golden is this package's own file; the assertions below fail on any field it lacks.
const GOLDEN = JSON.parse(readFileSync(join(packageRoot(import.meta.url), "golden", "intentic-os.json"), "utf8")) as {
    readonly release: unknown;
    readonly status: readonly Readonly<Record<string, unknown>>[];
    readonly updateCheck: readonly Readonly<Record<string, unknown>>[];
};

test("every status and update check in the golden reads back field for field", () => {
    expect(GOLDEN.status.length).toBe(3);
    for (const status of GOLDEN.status) {
        const read: unknown = IntenticOsStatusSchema.parse(status);
        expect(read).toEqual(status);
    }
    for (const check of GOLDEN.updateCheck) {
        const read: unknown = IntenticOsUpdateCheckSchema.parse(check);
        expect(read).toEqual(check);
    }
});

test("a status from a newer ic keeps what this side reads, and only a wrong verdict, isolation or OS is no status", () => {
    const [quiet] = GOLDEN.status;
    const read: unknown = IntenticOsStatusSchema.parse({ ...quiet, pinned: true });
    expect(read).toEqual(quiet);
    expect(IntenticOsStatusSchema.safeParse({ ...quiet, health: { verdict: "amber", failed: [] } }).success).toBe(false);
    expect(IntenticOsStatusSchema.safeParse({ ...quiet, isolation: "gvisor" }).success).toBe(false);
    expect(IntenticOsStatusSchema.safeParse({ ...quiet, os: "fedora" }).success).toBe(false);
});

test("the facts a device reports are release.json's edition, version and channel, under the OS's own name", () => {
    const release = IntenticOsReleaseSchema.parse(GOLDEN.release);
    const facts = intenticOsFactsFrom(release);
    expect(facts).toEqual({ name: "intentic-os", edition: "server", version: "2026.10.13.0", channel: "stable" });
    expect(isIntenticOs({ intenticOs: facts })).toBe(true);
    expect(isIntenticOs({})).toBe(false);
    expect(isIntenticOs(undefined)).toBe(false);
    expect(isIntenticOs({ intenticOs: { name: "Intentic OS" } })).toBe(false);
    // An optional fact: a device on any other OS says nothing, and an older daemon's read of a newer one is unharmed.
    const device = { os: "Intentic OS 2026.10.13.0 (kernel 6.11)", arch: "x64", shell: "/bin/bash", home: "/var/home/intentic", roots: [] };
    expect(DeviceFactsSchema.parse({ ...device, intenticOs: facts }).intenticOs).toEqual(facts);
    expect(DeviceFactsSchema.parse(device).intenticOs).toBeUndefined();
});

test("a release.json without its edition, version or channel is not one", () => {
    expect(IntenticOsReleaseSchema.safeParse({ name: "Intentic OS", edition: "server", version: "2026.10.13.0" }).success).toBe(false);
});

test("the argv is ic's own verbs, the one spelling every caller uses", () => {
    expect(icOsStatusArgs()).toEqual(["os", "status", "--json"]);
    expect(icOsUpdateArgs("check")).toEqual(["os", "update", "--check", "--json"]);
    expect(icOsUpdateArgs("stage")).toEqual(["os", "update"]);
    expect(icOsUpdateArgs("apply")).toEqual(["os", "update", "--apply"]);
    expect(icOsRollbackArgs(false)).toEqual(["os", "rollback"]);
    expect(icOsRollbackArgs(true)).toEqual(["os", "rollback", "--apply"]);
    expect(icOsRebootArgs()).toEqual(["os", "reboot"]);
    expect(icOsChannelArgs("beta")).toEqual(["os", "channel", "beta"]);
    expect(icOsChannelArgs("stable")).toEqual(["os", "channel", "stable"]);
});

test("a channel ic does not have never reaches it, even past the type", () => {
    for (const channel of ["--apply", "nightly"]) {
        // SAFETY: deliberately not a channel: what a caller that skipped its own schema would pass.
        expect(() => icOsChannelArgs(channel as IntenticOsChannel), channel).toThrow();
    }
});
