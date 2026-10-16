import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import type { IntenticOsStatus } from "@intentic/sandbox-contract/schemas/intentic-os";
import { ScopeError } from "../../policy.js";
import { intenticOsLine } from "../describe.js";
import { intenticOsFactsOf, type OsDeps, osChannel, osReboot, osRollback, osStatus, osUpdate } from "./os.js";
import type { IcRun } from "../sandboxes.js";

// The os_* tools are thin callers of `ic os`: what they may do is the device's switches, what they run is the contract's
// argv, and what they answer is ic's JSON read as the contract's. ic is a fake here that records what it was asked.

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

// What `ic os status --json` prints on a box with an update staged (the contract's golden/intentic-os.json, second case).
const STATUS: IntenticOsStatus = {
    os: "intentic-os",
    edition: "server",
    version: "2026.10.13.0",
    channel: "stable",
    image: "ghcr.io/intentic/os:stable",
    booted: { image: "ghcr.io/intentic/os:stable", version: "2026.10.13.0", digest: "sha256:aa", timestamp: "2026-10-13T09:12:00Z" },
    staged: { image: "ghcr.io/intentic/os:stable", version: "2026.10.14.0", digest: "sha256:bb", timestamp: null },
    rollback: null,
    rollbackQueued: false,
    rebootRequired: true,
    health: { verdict: "green", failed: [] },
    isolation: "auto",
    vmRuntime: true,
};

interface Asked {
    readonly args: readonly string[];
    readonly deadlineMs: number | undefined;
}

interface FakeIc {
    readonly deps: OsDeps;
    readonly asked: Asked[];
}

// An ic that answers `run` to everything and remembers each argv and whether it was given a deadline.
const fakeIc = (run: IcRun): FakeIc => {
    const asked: Asked[] = [];
    return {
        asked,
        deps: {
            ic: async (args, { deadlineMs }) => {
                asked.push({ args, deadlineMs });
                return run;
            },
        },
    };
};

const ok = (output: string): IcRun => ({ code: 0, output });

describe("os_status", () => {
    test("is ic's own status, read as the contract's and answered as JSON, behind a deadline", async () => {
        const ic = fakeIc(ok(`note: bootc answered slowly\n${JSON.stringify({ ...STATUS, newerField: 1 })}\n`));
        expect(JSON.parse(await osStatus(scopes(), ic.deps))).toEqual(STATUS);
        expect(ic.asked).toEqual([{ args: ["os", "status", "--json"], deadlineMs: 60_000 }]);
    });

    test("is a way of seeing: either switch will do, and neither is refused before ic is asked", async () => {
        const ic = fakeIc(ok(JSON.stringify(STATUS)));
        await expect(osStatus(scopes({ shell: "off" }), ic.deps)).resolves.toContain("intentic-os");
        await expect(osStatus(scopes({ sandboxes: "off" }), ic.deps)).resolves.toContain("intentic-os");
        await expect(osStatus(scopes({ shell: "off", sandboxes: "off" }), ic.deps)).rejects.toThrow(ScopeError);
        await expect(osStatus(scopes({ shell: "off", sandboxes: "off" }), ic.deps)).rejects.toThrow(/Manage sandboxes on this device/);
        expect(ic.asked).toHaveLength(2);
    });

    test("an answer in a shape this agent cannot read says so, with what ic printed", async () => {
        await expect(osStatus(scopes(), fakeIc(ok(JSON.stringify({ ...STATUS, health: { verdict: "amber", failed: [] } }))).deps)).rejects.toThrow(
            /did not answer `ic os status --json` in the shape this agent reads/,
        );
        await expect(osStatus(scopes(), fakeIc(ok("error: unrecognized subcommand 'os'")).deps)).rejects.toThrow(/unrecognized subcommand 'os'/);
    });

    test("ic's refusal on a machine that is not Intentic OS is said as that", async () => {
        await expect(osStatus(scopes(), fakeIc({ code: 3, output: "not Intentic OS" }).deps)).rejects.toThrow(/not running Intentic OS/);
    });
});

describe("os_update", () => {
    test("check asks the registry, changes nothing, and is gated as a read", async () => {
        const answer = { available: true, version: "2026.10.20.0", digest: "sha256:cc" };
        const ic = fakeIc(ok(JSON.stringify(answer)));
        expect(JSON.parse(await osUpdate("check", scopes({ sandboxes: "off" }), ic.deps))).toEqual(answer);
        expect(ic.asked).toEqual([{ args: ["os", "update", "--check", "--json"], deadlineMs: 180_000 }]);
        await expect(osUpdate("check", scopes({ shell: "off", sandboxes: "off" }), ic.deps)).rejects.toThrow(ScopeError);
    });

    test("stage and apply need Manage sandboxes, whatever else is on, and ic is never asked without it", async () => {
        const ic = fakeIc(ok("staged 2026.10.14.0"));
        for (const op of ["stage", "apply"] as const) {
            await expect(osUpdate(op, scopes({ sandboxes: "off", destructive: "on" }), ic.deps), op).rejects.toThrow(/Manage sandboxes on this device/);
        }
        expect(ic.asked).toEqual([]);
    });

    test("stage downloads for the next boot and restarts nothing; apply reboots, and says whose turns that ends", async () => {
        const ic = fakeIc(ok("downloading…\nstaged 2026.10.14.0 for the next boot\n"));
        const staged = await osUpdate("stage", scopes(), ic.deps);
        expect(staged).toStartWith("staged 2026.10.14.0 for the next boot");
        expect(staged).toContain("Nothing restarted");
        const applied = await osUpdate("apply", scopes(), ic.deps);
        expect(applied).toContain("restarts every sandbox on this device, the one this call came from included");
        expect(applied).toContain("os_status");
        // A flow left to finish, as a sandbox's swap is: no deadline.
        expect(ic.asked).toEqual([
            { args: ["os", "update"], deadlineMs: undefined },
            { args: ["os", "update", "--apply"], deadlineMs: undefined },
        ]);
    });

    test("a failed apply says nothing was rebooted, in ic's words", async () => {
        await expect(osUpdate("apply", scopes(), fakeIc({ code: 1, output: "error: sudo: a password is required" }).deps)).rejects.toThrow(
            /Nothing was rebooted\.\n\nerror: sudo: a password is required/,
        );
    });
});

describe("os_rollback, os_reboot and os_channel", () => {
    test("each runs ic's own verb, and only with Manage sandboxes", async () => {
        const ic = fakeIc(ok("done"));
        await osRollback(false, scopes(), ic.deps);
        await osRollback(true, scopes(), ic.deps);
        await osReboot(scopes(), ic.deps);
        await osChannel("beta", scopes(), ic.deps);
        expect(ic.asked.map((asked) => asked.args)).toEqual([["os", "rollback"], ["os", "rollback", "--apply"], ["os", "reboot"], ["os", "channel", "beta"]]);
        const off = scopes({ sandboxes: "off" });
        await expect(osRollback(false, off, ic.deps)).rejects.toThrow(ScopeError);
        await expect(osReboot(off, ic.deps)).rejects.toThrow(ScopeError);
        await expect(osChannel("stable", off, ic.deps)).rejects.toThrow(ScopeError);
        expect(ic.asked).toHaveLength(4);
    });

    test("a queued rollback and a channel switch restart nothing; a reboot says it restarts this sandbox too", async () => {
        const ic = fakeIc(ok(""));
        expect(await osRollback(false, scopes(), ic.deps)).toContain("Nothing restarted");
        expect(await osChannel("beta", scopes(), ic.deps)).toContain("Nothing restarted");
        expect(await osRollback(true, scopes(), ic.deps)).toContain("the one this call came from included");
        expect(await osReboot(scopes(), ic.deps)).toStartWith("Rebooting.");
    });
});

describe("what a device on Intentic OS reports", () => {
    const release = { name: "Intentic OS", edition: "desktop", version: "2026.10.13.0", channel: "beta", repository: "ghcr.io/intentic/os-desktop" };

    test("its facts are release.json's edition, version and channel under the OS's own name", () => {
        expect(intenticOsFactsOf(JSON.stringify(release))).toEqual({ name: "intentic-os", edition: "desktop", version: "2026.10.13.0", channel: "beta" });
    });

    test("no file, a torn one, or one missing a field reports nothing", () => {
        expect(intenticOsFactsOf(undefined)).toBeUndefined();
        expect(intenticOsFactsOf("{ not json")).toBeUndefined();
        expect(intenticOsFactsOf(JSON.stringify({ ...release, channel: undefined }))).toBeUndefined();
    });

    test("describe names it and the tools that manage it, and says nothing on any other OS", () => {
        const facts = intenticOsFactsOf(JSON.stringify(release));
        expect(intenticOsLine({ intenticOs: facts })).toEqual([
            "Intentic OS: the desktop edition, 2026.10.13.0, on the beta channel. os_status says what is staged and how this boot's health checks went; os_update, os_rollback, os_reboot and os_channel manage it through ic. Never bootc directly.",
        ]);
        expect(intenticOsLine({})).toEqual([]);
    });
});
