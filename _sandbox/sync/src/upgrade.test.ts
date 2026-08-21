import { describe, expect, it } from "vitest";
import { agentPath, runUpgrade, type UpgradeExec, upgradeMessage } from "./upgrade.js";

/* A scripted UpgradeExec that records what happened in order. The ORDER is the whole subject of these tests: an
 * upgrade is a sequence of steps chosen so that everything reversible happens before the one thing that is not,
 * and a rearrangement that still passes a "did it install?" assertion is exactly how this stops being safe. */
const scripted = (overrides: Partial<UpgradeExec> & { readonly downloaded?: string | undefined } = {}) => {
    const steps: string[] = [];
    const exec: UpgradeExec = {
        fetchTo: async (_url, dest) => {
            steps.push(`fetch→${dest}`);
            return await Promise.resolve();
        },
        probe: (binary) => {
            steps.push(`probe ${binary}`);
            const version = "downloaded" in overrides ? overrides.downloaded : "2.0.0";
            return version === undefined ? { kind: "unusable" } : { kind: "version", version };
        },
        swap: async (from, to) => {
            steps.push(`swap ${from}→${to}`);
            return await Promise.resolve();
        },
        stopWatcher: async () => {
            steps.push(`stop`);
            return await Promise.resolve(4242);
        },
        startWatcher: async () => {
            steps.push(`start`);
            return await Promise.resolve();
        },
        watcherAlive: async () => await Promise.resolve(true),
        discard: async (path) => {
            steps.push(`discard ${path}`);
            return await Promise.resolve();
        },
        ...overrides,
    };
    return { steps, exec };
};

const URL = "https://example.test/intentic-sync-linux-amd64";

describe("runUpgrade", () => {
    it("verifies the download before anything on this machine is touched", async () => {
        const { steps, exec } = scripted();
        const outcome = await runUpgrade(exec, URL, "1.0.0", false, () => undefined);
        expect(outcome).toEqual({ kind: "upgraded", from: "1.0.0", to: "2.0.0" });
        // The probe comes after the fetch and before the watcher is stopped, so a bad download costs nothing.
        expect(steps.indexOf(`probe ${agentPath}.new`)).toBeLessThan(steps.indexOf("stop"));
        expect(steps.indexOf("stop")).toBeLessThan(steps.findIndex((step) => step.startsWith(`swap ${agentPath}→`)));
    });

    // The refusal that matters most. A captive portal's login page, a truncated body and a binary for the wrong
    // architecture all download perfectly well; none of them is an agent, and the machine already has one.
    it("keeps the working agent when what downloaded doesn't run", async () => {
        const { steps, exec } = scripted({ downloaded: undefined });
        const outcome = await runUpgrade(exec, URL, "1.0.0", false, () => undefined);
        expect(outcome.kind).toBe("failed");
        expect(steps).not.toContain("stop");
        expect(steps.some((step) => step.startsWith(`swap ${agentPath}.new`))).toBe(false);
        expect(steps).toContain(`discard ${agentPath}.new`);
    });

    it("leaves everything alone, and the watcher running, when the machine is already current", async () => {
        const { steps, exec } = scripted({ downloaded: "1.0.0" });
        expect(await runUpgrade(exec, URL, "1.0.0", false, () => undefined)).toEqual({ kind: "current", version: "1.0.0" });
        // Nothing restarts. A command that bounces the watcher even when there is nothing to do is a command
        // people learn not to run.
        expect(steps).not.toContain("stop");
        expect(steps).not.toContain("start");
    });

    it("reports a download that never arrived without touching the installed agent", async () => {
        const { steps, exec } = scripted({
            fetchTo: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
        });
        const outcome = await runUpgrade(exec, URL, "1.0.0", false, () => undefined);
        expect(outcome.kind).toBe("failed");
        expect(upgradeMessage(outcome)).toContain("nothing was changed");
        expect(steps).not.toContain("stop");
    });

    /* The one failure no check can front-run: the binary answers `version` and then cannot stay up on THIS
     * machine. Without the rollback an upgrade would turn a merely out-of-date computer into one with no working
     * sync at all, which is the outcome that would make the whole command not worth running. */
    it("restores the previous agent and restarts it when the new one won't stay up", async () => {
        const { steps, exec } = scripted({ watcherAlive: () => Promise.resolve(false) });
        const outcome = await runUpgrade(exec, URL, "1.0.0", false, () => undefined);
        expect(outcome.kind).toBe("failed");
        expect(upgradeMessage(outcome)).toContain("1.0.0 was restored and is running again");
        expect(steps).toContain(`swap ${agentPath}.previous→${agentPath}`);
        // Restored AND running: put back but left stopped is still a machine with no sync.
        expect(steps.lastIndexOf("start")).toBeGreaterThan(steps.indexOf(`swap ${agentPath}.previous→${agentPath}`));
        // The rollback copy is kept, not discarded, on the path that needed it.
        expect(steps).not.toContain(`discard ${agentPath}.previous`);
    });

    // A watcher that was deliberately stopped stays stopped. Upgrading is not consent to start a background
    // process somebody turned off, and with nothing to start, there is nothing to verify or roll back either.
    it("doesn't start a watcher that wasn't running before", async () => {
        const { steps, exec } = scripted({ stopWatcher: () => Promise.resolve(undefined) });
        expect(await runUpgrade(exec, URL, "1.0.0", false, () => undefined)).toEqual({ kind: "upgraded", from: "1.0.0", to: "2.0.0" });
        expect(steps).not.toContain("start");
    });
});

/* Upgrade is a direction, not just a swap. `latest` is whatever the release channel points at right now, and it
 * can sit BEHIND a given machine: a release pulled, or an agent built from source ahead of it. Installing it
 * anyway would remove whatever that machine is standing on, up to and including this command. */
describe("runUpgrade never moves a machine backwards", () => {
    it("declines a published agent older than the one installed", async () => {
        const { steps, exec } = scripted({ downloaded: "1.0.0" });
        expect(await runUpgrade(exec, URL, "1.5.0", false, () => undefined)).toEqual({ kind: "current", version: "1.5.0" });
        expect(steps).not.toContain("stop");
    });

    // A build made from source carries the dev sentinel, which every release outranks numerically, so the rule
    // above cannot see it, and the first upgrade on a developer's own machine would silently undo their build.
    it("leaves a build made from source alone, and says how to replace it on purpose", async () => {
        const { steps, exec } = scripted({ downloaded: "1.183.0" });
        const outcome = await runUpgrade(exec, URL, "0.0.0", false, () => undefined);
        expect(outcome.kind).toBe("current");
        expect(upgradeMessage(outcome)).toContain("--force");
        expect(steps).not.toContain("stop");
    });

    it("replaces a build made from source when asked to", async () => {
        const { steps, exec } = scripted({ downloaded: "1.183.0" });
        expect(await runUpgrade(exec, URL, "0.0.0", true, () => undefined)).toEqual({ kind: "upgraded", from: "0.0.0", to: "1.183.0" });
        expect(steps).toContain("stop");
    });
});

/* The first real run of this command hit exactly this: the published agent was older than the `version` command
 * it was being asked for, and the refusal reported it as a download that "doesn't run as an agent". The decision
 * was right and the reason was wrong, which is the pair that sends someone debugging their network. */
it(`recognises a published agent too old to state its version, and says so`, async () => {
    const { steps, exec } = scripted({ probe: () => ({ kind: "no-version-command" }) });
    const outcome = await runUpgrade(exec, URL, "0.0.0", false, () => undefined);
    expect(outcome.kind).toBe("current");
    expect(upgradeMessage(outcome)).toContain("predates");
    expect(upgradeMessage(outcome)).not.toContain("doesn't run as an agent");
    expect(steps).not.toContain("stop");
});

// …and --force does not override it. That flag is for replacing a build made from SOURCE on purpose, not for
// installing bytes whose version nothing can establish.
it(`won't install an unidentifiable agent even when forced`, async () => {
    const { steps, exec } = scripted({ probe: () => ({ kind: "no-version-command" }) });
    expect((await runUpgrade(exec, URL, "0.0.0", true, () => undefined)).kind).toBe("current");
    expect(steps).not.toContain("stop");
});
