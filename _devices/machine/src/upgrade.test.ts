import { describe, expect, it } from "vitest";
import { agentPath } from "./installed.js";
import { runUpgrade, type UpgradeExec, type UpgradeOutcome, upgradeMessage } from "./upgrade.js";

// Records steps in order, so tests can check the sequence, not just the outcome. Three scripted versions
// (downloaded, running, came-up) exist because collapsing them let "upgraded" mean only "bytes on disk".
interface Scripted {
    /** What the probe says landed. Undefined is a download that is not an agent at all. */
    readonly downloaded?: string | undefined;
    /** What the loop holding the pidfile is running before anything happens. Undefined is nothing running. */
    readonly running?: string | undefined;
    /** What comes up when the loop is started. Defaults to what was installed; undefined is nothing came up. */
    readonly came?: string | undefined;
}

const scripted = (overrides: Partial<UpgradeExec> & Scripted = {}) => {
    const steps: string[] = [];
    const downloaded = "downloaded" in overrides ? overrides.downloaded : "2.0.0";
    const exec: UpgradeExec = {
        // Unresolvable by default: nothing is skipped on the strength of a tag, the download happens, and what it
        // downloaded decides.
        published: async () => await Promise.resolve(undefined),
        fetchTo: async (_url, dest) => {
            steps.push(`fetch→${dest}`);
            return await Promise.resolve();
        },
        probe: (binary) => {
            steps.push(`probe ${binary}`);
            return downloaded === undefined ? { kind: "unusable" } : { kind: "version", version: downloaded };
        },
        swap: async (from, to) => {
            steps.push(`swap ${from}→${to}`);
            return await Promise.resolve();
        },
        stopWatcher: async () => {
            steps.push(`stop`);
            return await Promise.resolve(4242);
        },
        // A healthy machine comes up on what was just installed, so the post-swap check passes here the same way it
        // does
        // in the field.
        startWatcher: async () => {
            steps.push(`start`);
            return await Promise.resolve("came" in overrides ? overrides.came : downloaded);
        },
        // Nothing running unless a test says otherwise, or an assumed loop would quietly satisfy the check under test.
        runningBuild: async () => await Promise.resolve(overrides.running),
        discard: async (path) => {
            steps.push(`discard ${path}`);
            return await Promise.resolve();
        },
        ...overrides,
    };
    return { steps, exec };
};

const URL = "https://example.test/intentic-machine-linux-amd64";

// Every test drives the same command; only the exec, installed version, and force flag differ. The asset arg is
// a function but ignored here, since these tests are about step order, not the fetch address.
const upgrade = async (exec: UpgradeExec, installed: string, force = false): Promise<UpgradeOutcome> =>
    await runUpgrade(
        exec,
        () => URL,
        installed,
        force,
        () => undefined,
    );

describe("runUpgrade", () => {
    it("verifies the download before anything on this machine is touched", async () => {
        const { steps, exec } = scripted();
        const outcome = await upgrade(exec, "1.0.0");
        expect(outcome).toEqual({ kind: "upgraded", from: "1.0.0", to: "2.0.0" });
        // The probe comes after the fetch and before the watcher is stopped, so a bad download costs nothing.
        expect(steps.indexOf(`probe ${agentPath}.new`)).toBeLessThan(steps.indexOf("stop"));
        expect(steps.indexOf("stop")).toBeLessThan(steps.findIndex((step) => step.startsWith(`swap ${agentPath}→`)));
    });

    // The refusal that matters most: a captive-portal page, a truncated body, or the wrong architecture all download
    // fine but aren't an agent, and the machine already has one.
    it("keeps the working agent when what downloaded doesn't run", async () => {
        const { steps, exec } = scripted({ downloaded: undefined });
        const outcome = await upgrade(exec, "1.0.0");
        expect(outcome.kind).toBe("failed");
        expect(steps).not.toContain("stop");
        expect(steps.some((step) => step.startsWith(`swap ${agentPath}.new`))).toBe(false);
        expect(steps).toContain(`discard ${agentPath}.new`);
    });

    it("leaves everything alone, and the watcher running, when the machine is already current", async () => {
        const { steps, exec } = scripted({ downloaded: "1.0.0" });
        expect(await upgrade(exec, "1.0.0")).toEqual({ kind: "current", version: "1.0.0" });
        // Nothing restarts; a command that bounces the watcher for no reason is one people learn not to run.
        expect(steps).not.toContain("stop");
        expect(steps).not.toContain("start");
    });

    it("reports a download that never arrived without touching the installed agent", async () => {
        const { steps, exec } = scripted({
            fetchTo: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
        });
        const outcome = await upgrade(exec, "1.0.0");
        expect(outcome.kind).toBe("failed");
        expect(upgradeMessage(outcome)).toContain("ENOTFOUND");
        expect(steps).not.toContain("stop");
    });

    // The one failure no check can front-run: the binary answers `version` but can't stay up here. Without the
    // rollback, an upgrade would turn an out-of-date device into one with no sync at all.
    it("restores the previous agent and restarts it when the new one won't stay up", async () => {
        const { steps, exec } = scripted({ came: undefined });
        const installed = "1.0.0";
        const outcome = await upgrade(exec, installed);
        expect(outcome.kind).toBe("failed");
        expect(upgradeMessage(outcome)).toContain(installed);
        expect(steps).toContain(`swap ${agentPath}.previous→${agentPath}`);
        // Restored and running: put back but left stopped is still a machine with no sync.
        expect(steps.lastIndexOf("start")).toBeGreaterThan(steps.indexOf(`swap ${agentPath}.previous→${agentPath}`));
        // The rollback copy is kept, not discarded, on the path that needed it.
        expect(steps).not.toContain(`discard ${agentPath}.previous`);
    });

    // A deliberately stopped watcher stays stopped; upgrading isn't consent to start it, and with nothing to start
    // there's nothing to verify or roll back.
    it("doesn't start a watcher that wasn't running before", async () => {
        const { steps, exec } = scripted({ stopWatcher: () => Promise.resolve(undefined) });
        expect(await upgrade(exec, "1.0.0")).toEqual({ kind: "upgraded", from: "1.0.0", to: "2.0.0" });
        expect(steps).not.toContain("start");
    });

    // The swap landed but something else is still serving; not a rollback, since the bytes are in place and undoing
    // that would throw away work that succeeded.
    it("names the build still serving when the loop that came up isn't the one installed", async () => {
        const { steps, exec } = scripted({ came: "1.0.0" });
        expect(await upgrade(exec, "1.0.0")).toEqual({ kind: "loop-behind", installed: "2.0.0", running: "1.0.0" });
        expect(steps).not.toContain(`swap ${agentPath}.previous→${agentPath}`);
        expect(steps).toContain(`discard ${agentPath}.previous`);
    });
});

// Upgrade is about what's running, not what's on disk: a binary can land without the loop noticing (a re-run, a
// manual copy, a failed restart), and the loop keeps its started build indefinitely.
describe("runUpgrade reconciles the running loop", () => {
    it("restarts a loop that is behind the installed binary, without downloading anything", async () => {
        const { steps, exec } = scripted({ published: () => Promise.resolve("1.0.0"), running: "0.9.0", came: "1.0.0" });
        expect(await upgrade(exec, "1.0.0")).toEqual({ kind: "restarted", from: "0.9.0", to: "1.0.0" });
        expect(steps).toEqual(["start"]);
        expect(upgradeMessage({ kind: "restarted", from: "0.9.0", to: "1.0.0" })).toContain("still running 0.9.0");
    });

    // The rule that keeps this command cheap enough to run on a whim, rather than an unconditional bounce.
    it("leaves a loop already on the installed build strictly alone", async () => {
        const { steps, exec } = scripted({ published: () => Promise.resolve("1.0.0"), running: "1.0.0" });
        expect(await upgrade(exec, "1.0.0")).toEqual({ kind: "current", version: "1.0.0" });
        expect(steps).toEqual([]);
    });

    // Nothing running is not a skew: `run --stop` is deliberate, and an upgrade that starts it anyway is one people
    // stop trusting.
    it("starts nothing when no loop is running at all", async () => {
        const { steps, exec } = scripted({ published: () => Promise.resolve("1.0.0") });
        expect(await upgrade(exec, "1.0.0")).toEqual({ kind: "current", version: "1.0.0" });
        expect(steps).toEqual([]);
    });

    it("says which build is still serving when the restart doesn't take", async () => {
        const { exec } = scripted({ published: () => Promise.resolve("1.0.0"), running: "0.9.0", came: "0.9.0" });
        const outcome = await upgrade(exec, "1.0.0");
        expect(outcome).toEqual({ kind: "loop-behind", installed: "1.0.0", running: "0.9.0" });
        expect(upgradeMessage(outcome)).toContain("intentic-machine run --stop");
    });

    // The other way a restart ends badly: the old loop went down and nothing replaced it. That's not "running
    // another build", and telling the owner to stop an already-stopped process sends them looking for a process that
    // isn't there.
    it("says nothing came back when the restart leaves the machine unserved", async () => {
        const { exec } = scripted({ published: () => Promise.resolve("1.0.0"), running: "0.9.0", came: undefined });
        const outcome = await upgrade(exec, "1.0.0");
        expect(outcome).toEqual({ kind: "loop-behind", installed: "1.0.0" });
        expect(upgradeMessage(outcome)).toContain("didn't come back up");
        expect(upgradeMessage(outcome)).not.toContain("run --stop");
    });

    // The same reconciliation runs when the release channel couldn't be read at all. The two verdicts that carry a
    // note are deliberately not on this path, since each is about a machine off the release lane on purpose.
    it("reconciles the loop after a download that installs nothing", async () => {
        const { steps, exec } = scripted({ downloaded: "1.0.0", running: "0.9.0", came: "1.0.0" });
        expect(await upgrade(exec, "1.0.0")).toEqual({ kind: "restarted", from: "0.9.0", to: "1.0.0" });
        expect(steps).toContain("start");
    });

    it("leaves a build made from source unbounced", async () => {
        const { steps, exec } = scripted({ downloaded: "1.183.0", running: "1.183.0" });
        expect((await upgrade(exec, "0.0.0")).kind).toBe("current");
        expect(steps).not.toContain("start");
    });
});

// Asks the release channel before moving ~95 MB: downloading the whole agent just to compare version strings
// when already current made the command feel like something to avoid.
describe("runUpgrade asks what is published first", () => {
    it("downloads nothing when the published version is the one already installed", async () => {
        const { steps, exec } = scripted({ published: () => Promise.resolve("1.0.0") });
        expect(await upgrade(exec, "1.0.0")).toEqual({ kind: "current", version: "1.0.0" });
        expect(steps).toEqual([]);
    });

    // Same rule as the probe's, so the shortcut can never disagree with the decision it shortens: a channel behind
    // this machine isn't worth downloading either.
    it("downloads nothing when the published version is older than the installed one", async () => {
        const { steps, exec } = scripted({ published: () => Promise.resolve("1.4.0") });
        expect(await upgrade(exec, "1.5.0")).toEqual({ kind: "current", version: "1.5.0" });
        expect(steps).toEqual([]);
    });

    // A build from source is the one case the shortcut must not take: 0.0.0 loses to every release numerically, and
    // replacing it is `--force`'s question, decided later on what actually downloaded.
    it("still downloads over a build made from source", async () => {
        const { steps, exec } = scripted({ published: () => Promise.resolve("1.4.0"), downloaded: "1.4.0" });
        await upgrade(exec, "0.0.0", true);
        expect(steps[0]).toBe(`fetch→${agentPath}.new-1.4.0`);
    });

    // The part file is named for the release it holds, which is what lets a dropped transfer resume safely: bytes
    // from two releases can never share one file. A run that can't name the release discards its part instead.
    it("keeps what arrived when it knows which release those bytes are", async () => {
        const { steps, exec } = scripted({
            published: () => Promise.resolve("2.0.0"),
            fetchTo: () => Promise.reject(new Error("socket hang up")),
        });
        const outcome = await upgrade(exec, "1.0.0");
        expect(outcome.kind).toBe("failed");
        expect(outcome.kind === "failed" && outcome.reason).toContain("continues");
        expect(steps).not.toContain(`discard ${agentPath}.new-2.0.0`);
    });

    it("throws away what arrived when it cannot", async () => {
        const { steps, exec } = scripted({ fetchTo: () => Promise.reject(new Error("socket hang up")) });
        expect((await upgrade(exec, "1.0.0")).kind).toBe("failed");
        expect(steps).toContain(`discard ${agentPath}.new`);
    });
});

// Upgrade is a direction, not just a swap: `latest` can sit behind a given machine (a pulled release, or a
// from-source build ahead of it), and installing it anyway would remove what the machine stands on.
describe("runUpgrade never moves a machine backwards", () => {
    it("declines a published agent older than the one installed", async () => {
        const { steps, exec } = scripted({ downloaded: "1.0.0" });
        expect(await upgrade(exec, "1.5.0")).toEqual({ kind: "current", version: "1.5.0" });
        expect(steps).not.toContain("stop");
    });

    // A from-source build carries the dev sentinel, which every release outranks numerically; without an exception,
    // the first upgrade would silently undo it.
    it("leaves a build made from source alone, and says how to replace it on purpose", async () => {
        const { steps, exec } = scripted({ downloaded: "1.183.0" });
        const outcome = await upgrade(exec, "0.0.0");
        expect(outcome.kind).toBe("current");
        expect(upgradeMessage(outcome)).toContain("--force");
        expect(steps).not.toContain("stop");
    });

    it("replaces a build made from source when asked to", async () => {
        const { steps, exec } = scripted({ downloaded: "1.183.0" });
        expect(await upgrade(exec, "0.0.0", true)).toEqual({ kind: "upgraded", from: "0.0.0", to: "1.183.0" });
        expect(steps).toContain("stop");
    });
});

// A published agent too old to answer `version` must be declined with the right reason: reporting it as
// "doesn't run as an agent" looks like a network problem instead of an old release.
it(`recognises a published agent too old to state its version, and says so`, async () => {
    const { steps, exec } = scripted({ probe: () => ({ kind: "no-version-command" }) });
    const outcome = await upgrade(exec, "0.0.0");
    expect(outcome.kind).toBe("current");
    expect(upgradeMessage(outcome)).toContain("predates");
    expect(upgradeMessage(outcome)).not.toContain("doesn't run as an agent");
    expect(steps).not.toContain("stop");
});

// --force doesn't override this: it's for replacing a from-source build on purpose, not installing bytes whose
// version can't be established.
it(`won't install an unidentifiable agent even when forced`, async () => {
    const { steps, exec } = scripted({ probe: () => ({ kind: "no-version-command" }) });
    expect((await upgrade(exec, "0.0.0", true)).kind).toBe("current");
    expect(steps).not.toContain("stop");
});
