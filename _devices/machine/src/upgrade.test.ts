import { describe, expect, it } from "vitest";
import { agentPath } from "./installed.js";
import { runUpgrade, type UpgradeExec, type UpgradeOutcome, upgradeMessage } from "./upgrade.js";

/* A scripted UpgradeExec that records what happened in order. The ORDER is the whole subject of these tests: an
 * upgrade is a sequence of steps chosen so that everything reversible happens before the one thing that is not,
 * and a rearrangement that still passes a "did it install?" assertion is exactly how this stops being safe.
 *
 * The three scripted VERSIONS are the other subject, and they are three because the machine has three: what
 * downloaded, what the loop is running right now, and what it comes up on after a restart. Collapsing them is
 * how "upgraded" came to mean "the bytes are on disk" — the case this fake now makes it possible to fail. */
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
        // Unresolvable by default, which is the shape every test below was written against: nothing is skipped
        // on the strength of a tag, the download happens, and what it downloaded is what decides.
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
        // A healthy machine comes up on what was just installed, which is what makes the post-swap check pass
        // here for the same reason it passes in the field.
        startWatcher: async () => {
            steps.push(`start`);
            return await Promise.resolve("came" in overrides ? overrides.came : downloaded);
        },
        // Nothing running unless a test says otherwise: an assumed loop would quietly satisfy the very check
        // these tests exist to hold.
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

// Every test drives the same command, and only three things about it ever differ: the scripted exec, the
// version this machine is on, and whether it was forced. The asset is a FUNCTION because the real caller pins
// the URL to the version it resolved (assetUrl), and this one ignores that argument on purpose: what the tests
// are about is the order of the steps, not the address they fetch from.
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

    // The refusal that matters most. A captive portal's login page, a truncated body and a binary for the wrong
    // architecture all download perfectly well; none of them is an agent, and the machine already has one.
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
        // Nothing restarts. A command that bounces the watcher even when there is nothing to do is a command
        // people learn not to run.
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

    /* The one failure no check can front-run: the binary answers `version` and then cannot stay up on THIS
     * machine. Without the rollback an upgrade would turn a merely out-of-date device into one with no working
     * sync at all, which is the outcome that would make the whole command not worth running. */
    it("restores the previous agent and restarts it when the new one won't stay up", async () => {
        const { steps, exec } = scripted({ came: undefined });
        const installed = "1.0.0";
        const outcome = await upgrade(exec, installed);
        expect(outcome.kind).toBe("failed");
        expect(upgradeMessage(outcome)).toContain(installed);
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
        expect(await upgrade(exec, "1.0.0")).toEqual({ kind: "upgraded", from: "1.0.0", to: "2.0.0" });
        expect(steps).not.toContain("start");
    });

    /* THE SWAP LANDED AND SOMETHING ELSE IS STILL SERVING — reported as a completed upgrade for as long as the
     * check after the restart was "is a process alive", which the agent being replaced answers perfectly well.
     * Not a rollback: the bytes are in place and undoing that would throw away work that succeeded. */
    it("names the build still serving when the loop that came up isn't the one installed", async () => {
        const { steps, exec } = scripted({ came: "1.0.0" });
        expect(await upgrade(exec, "1.0.0")).toEqual({ kind: "loop-behind", installed: "2.0.0", running: "1.0.0" });
        expect(steps).not.toContain(`swap ${agentPath}.previous→${agentPath}`);
        expect(steps).toContain(`discard ${agentPath}.previous`);
    });
});

/* UPGRADE IS ABOUT WHAT IS RUNNING, not about what is on disk — the half of this command that did not exist.
 *
 * A binary can land without the loop noticing (a card's one-liner re-run, a copy dropped into ~/.intentic/bin, an
 * upgrade whose restart did not take), and the loop keeps the build it started with for as long as it lives. Every
 * version anyone could read was the file's, so the machine reported the old build to its sandboxes indefinitely
 * while this command answered "Already on the current agent. Nothing to do." */
describe("runUpgrade reconciles the running loop", () => {
    it("restarts a loop that is behind the installed binary, without downloading anything", async () => {
        const { steps, exec } = scripted({ published: () => Promise.resolve("1.0.0"), running: "0.9.0", came: "1.0.0" });
        expect(await upgrade(exec, "1.0.0")).toEqual({ kind: "restarted", from: "0.9.0", to: "1.0.0" });
        expect(steps).toEqual(["start"]);
        expect(upgradeMessage({ kind: "restarted", from: "0.9.0", to: "1.0.0" })).toContain("still running 0.9.0");
    });

    // The rule that keeps the command cheap enough to run on a whim, and the reason this is a comparison rather
    // than an unconditional bounce.
    it("leaves a loop already on the installed build strictly alone", async () => {
        const { steps, exec } = scripted({ published: () => Promise.resolve("1.0.0"), running: "1.0.0" });
        expect(await upgrade(exec, "1.0.0")).toEqual({ kind: "current", version: "1.0.0" });
        expect(steps).toEqual([]);
    });

    // Nothing running is not a skew: `run --stop` is a thing people do on purpose, and an upgrade that starts
    // what somebody deliberately stopped is one they stop trusting.
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

    // The other way a restart ends badly: the old loop went down and nothing replaced it. A machine with nothing
    // serving is not a machine "running another build", and telling its owner to stop what is already stopped is
    // the kind of instruction that sends someone looking for a process that isn't there.
    it("says nothing came back when the restart leaves the machine unserved", async () => {
        const { exec } = scripted({ published: () => Promise.resolve("1.0.0"), running: "0.9.0", came: undefined });
        const outcome = await upgrade(exec, "1.0.0");
        expect(outcome).toEqual({ kind: "loop-behind", installed: "1.0.0" });
        expect(upgradeMessage(outcome)).toContain("didn't come back up");
        expect(upgradeMessage(outcome)).not.toContain("run --stop");
    });

    /* The same reconciliation after a download that turned out not to be newer — the path taken when the release
     * channel could not be read at all. The two verdicts that carry a note are deliberately not on it: each is
     * about a machine that is off the release lane on purpose. */
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

/* WHAT THE RELEASE CHANNEL SAYS, ASKED BEFORE ~95 MB MOVES. Until this existed, `upgrade` on a machine that was
 * already current downloaded the whole agent, ran it, compared two strings and printed "nothing to do" — a
 * two-minute answer to a question a HEAD request answers in a moment, which is what made the command feel like
 * something to avoid rather than something to run. */
describe("runUpgrade asks what is published first", () => {
    it("downloads nothing when the published version is the one already installed", async () => {
        const { steps, exec } = scripted({ published: () => Promise.resolve("1.0.0") });
        expect(await upgrade(exec, "1.0.0")).toEqual({ kind: "current", version: "1.0.0" });
        expect(steps).toEqual([]);
    });

    // Same rule as the probe's, so the shortcut can never disagree with the decision it is shortening: a channel
    // that has moved BACKWARDS of this machine is not something to download either.
    it("downloads nothing when the published version is older than the installed one", async () => {
        const { steps, exec } = scripted({ published: () => Promise.resolve("1.4.0") });
        expect(await upgrade(exec, "1.5.0")).toEqual({ kind: "current", version: "1.5.0" });
        expect(steps).toEqual([]);
    });

    // A build from source is the one case the shortcut must NOT take: 0.0.0 loses to every release numerically,
    // and whether to replace it is `--force`'s question, decided further down on what actually downloaded.
    it("still downloads over a build made from source", async () => {
        const { steps, exec } = scripted({ published: () => Promise.resolve("1.4.0"), downloaded: "1.4.0" });
        await upgrade(exec, "0.0.0", true);
        expect(steps[0]).toBe(`fetch→${agentPath}.new-1.4.0`);
    });

    /* The part file is named for the release it holds, and that is the whole reason a dropped transfer can be
     * continued at all: bytes from two different releases can never end up in one file. A run that cannot name
     * the release cannot promise that, so it throws its part away instead. */
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

/* Upgrade is a direction, not just a swap. `latest` is whatever the release channel points at right now, and it
 * can sit BEHIND a given machine: a release pulled, or an agent built from source ahead of it. Installing it
 * anyway would remove whatever that machine is standing on, up to and including this command. */
describe("runUpgrade never moves a machine backwards", () => {
    it("declines a published agent older than the one installed", async () => {
        const { steps, exec } = scripted({ downloaded: "1.0.0" });
        expect(await upgrade(exec, "1.5.0")).toEqual({ kind: "current", version: "1.5.0" });
        expect(steps).not.toContain("stop");
    });

    // A build made from source carries the dev sentinel, which every release outranks numerically, so the rule
    // above cannot see it, and the first upgrade on a developer's own machine would silently undo their build.
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

/* The first real run of this command hit exactly this: the published agent was older than the `version` command
 * it was being asked for, and the refusal reported it as a download that "doesn't run as an agent". The decision
 * was right and the reason was wrong, which is the pair that sends someone debugging their network. */
it(`recognises a published agent too old to state its version, and says so`, async () => {
    const { steps, exec } = scripted({ probe: () => ({ kind: "no-version-command" }) });
    const outcome = await upgrade(exec, "0.0.0");
    expect(outcome.kind).toBe("current");
    expect(upgradeMessage(outcome)).toContain("predates");
    expect(upgradeMessage(outcome)).not.toContain("doesn't run as an agent");
    expect(steps).not.toContain("stop");
});

// …and --force does not override it. That flag is for replacing a build made from SOURCE on purpose, not for
// installing bytes whose version nothing can establish.
it(`won't install an unidentifiable agent even when forced`, async () => {
    const { steps, exec } = scripted({ probe: () => ({ kind: "no-version-command" }) });
    expect((await upgrade(exec, "0.0.0", true)).kind).toBe("current");
    expect(steps).not.toContain("stop");
});
