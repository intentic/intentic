import { agentAssetUrl, agentPath, launcherAssetUrl, launcherPath } from "./release.js";
import { runUpgrade, type UpgradeExec, type UpgradeOutcome, upgradeMessage } from "./upgrade.js";

// Records every effect in order, so a test checks the sequence and not just the outcome. Three versions are scripted
// (downloaded, running, came up) because collapsing them let "upgraded" mean only "bytes on disk".
interface Scripted {
    /** What the probe says landed. Undefined is a download that is not an agent at all. */
    readonly downloaded?: string | undefined;
    /** What the agent holding the pidfile runs before anything happens. Undefined is nothing running. */
    readonly running?: string | undefined;
    /** What comes up when the supervisor restarts it. Defaults to what was downloaded; undefined is nothing came up. */
    readonly came?: string | undefined;
}

const TARGET = "2.0.0";

const scripted = (overrides: Partial<UpgradeExec> & Scripted = {}) => {
    const steps: string[] = [];
    const downloaded = "downloaded" in overrides ? overrides.downloaded : TARGET;
    const running = "running" in overrides ? overrides.running : "1.0.0";
    const exec: UpgradeExec = {
        fetchTo: async (url, dest) => void steps.push(`fetch ${url} → ${dest}`),
        probe: (binary) => {
            steps.push(`probe ${binary}`);
            return downloaded;
        },
        swap: async (from, to) => void steps.push(`swap ${from} → ${to}`),
        runningBuild: async () => await Promise.resolve(running),
        restart: async () => {
            steps.push(`restart`);
            return await Promise.resolve("came" in overrides ? overrides.came : downloaded);
        },
        discard: async (path) => void steps.push(`discard ${path}`),
        withLauncher: false,
        ...overrides,
    };
    return { steps, exec };
};

const upgrade = async (exec: UpgradeExec, installed: string, target = TARGET, force = false): Promise<UpgradeOutcome> =>
    await runUpgrade(exec, target, installed, force, () => undefined);

const staged = `${agentPath}.new-${TARGET}`;
const previous = `${agentPath}.previous`;

describe("runUpgrade", () => {
    // Two environments of one PC must land on the same bytes, and a tag is the only name that means one set of them.
    it("downloads exactly the release it was given, into a part file named for it", async () => {
        const { steps, exec } = scripted();
        expect(await upgrade(exec, "1.0.0")).toEqual({ kind: "upgraded", from: "1.0.0", to: TARGET });
        expect(steps[0]).toBe(`fetch ${agentAssetUrl(TARGET)} → ${staged}`);
    });

    it("verifies the download before anything on this machine is touched", async () => {
        const { steps, exec } = scripted();
        await upgrade(exec, "1.0.0");
        expect(steps.indexOf(`probe ${staged}`)).toBeLessThan(steps.indexOf(`swap ${agentPath} → ${previous}`));
    });

    // Swapping first means whoever restarts the agent (systemd, the logon task, the Windows side) starts the new file:
    // stopping first left a window in which a supervisor brought the OLD build back.
    it("swaps the new binary in before restarting through the supervisor, and never stops the agent first", async () => {
        const { steps, exec } = scripted();
        await upgrade(exec, "1.0.0");
        expect(steps.filter((step) => !step.startsWith("fetch") && !step.startsWith("probe"))).toEqual([
            `swap ${agentPath} → ${previous}`,
            `swap ${staged} → ${agentPath}`,
            `restart`,
            `discard ${previous}`,
        ]);
    });

    // A captive-portal page, a truncated body, or the wrong architecture all download fine and aren't an agent.
    it("keeps the working agent when what downloaded doesn't run", async () => {
        const { steps, exec } = scripted({ downloaded: undefined });
        const outcome = await upgrade(exec, "1.0.0");
        expect(outcome.kind).toBe("failed");
        expect(steps.some((step) => step.startsWith("swap"))).toBe(false);
        expect(steps).toContain(`discard ${staged}`);
    });

    it("refuses a download that is an agent, but of another release than the one asked for", async () => {
        const { steps, exec } = scripted({ downloaded: "1.9.0" });
        const outcome = await upgrade(exec, "1.0.0");
        expect(outcome.kind === "failed" && outcome.reason).toContain("1.9.0");
        expect(steps.some((step) => step.startsWith("swap"))).toBe(false);
    });

    it("reports a download that never arrived, keeping what did arrive so the next run resumes it", async () => {
        const { steps, exec } = scripted({ fetchTo: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")) });
        const outcome = await upgrade(exec, "1.0.0");
        expect(upgradeMessage(outcome)).toContain("ENOTFOUND");
        expect(upgradeMessage(outcome)).toContain("continues");
        expect(steps).not.toContain(`discard ${staged}`);
        expect(steps.some((step) => step.startsWith("swap") || step === "restart")).toBe(false);
    });

    // The one failure no check can front-run: the binary answers `version` but can't stay up here.
    it("restores the previous agent and restarts it when the new one won't stay up", async () => {
        const { steps, exec } = scripted({ came: undefined });
        const outcome = await upgrade(exec, "1.0.0");
        expect(outcome.kind).toBe("failed");
        expect(upgradeMessage(outcome)).toContain("1.0.0");
        expect(steps.slice(-2)).toEqual([`swap ${previous} → ${agentPath}`, `restart`]);
        expect(steps).not.toContain(`discard ${previous}`);
    });

    // A deliberately stopped agent stays stopped; upgrading isn't consent to start it.
    it("doesn't start an agent that wasn't running before", async () => {
        const { steps, exec } = scripted({ running: undefined });
        expect(await upgrade(exec, "1.0.0")).toEqual({ kind: "upgraded", from: "1.0.0", to: TARGET });
        expect(steps).not.toContain("restart");
        expect(steps).toContain(`discard ${previous}`);
    });

    // The swap landed but something else is serving; not a rollback, since the bytes are in place.
    it("names the build still serving when the agent that came up isn't the one installed", async () => {
        const { steps, exec } = scripted({ came: "1.0.0" });
        expect(await upgrade(exec, "1.0.0")).toEqual({ kind: "agent-behind", installed: TARGET, running: "1.0.0" });
        expect(steps).not.toContain(`swap ${previous} → ${agentPath}`);
    });
});

// The launcher stub the logon task runs ships in every release beside the agent, so on Windows the two move as one.
describe("runUpgrade with the Windows launcher", () => {
    const launcherStaged = `${launcherPath}.new-${TARGET}`;
    const launcherPrevious = `${launcherPath}.previous`;

    it("fetches the launcher of the same release and swaps it in before the agent", async () => {
        const { steps, exec } = scripted({ withLauncher: true });
        expect((await upgrade(exec, "1.0.0")).kind).toBe("upgraded");
        expect(steps).toContain(`fetch ${launcherAssetUrl(TARGET)} → ${launcherStaged}`);
        expect(steps.indexOf(`swap ${launcherStaged} → ${launcherPath}`)).toBeLessThan(steps.indexOf(`swap ${staged} → ${agentPath}`));
    });

    it("puts both back, the agent first, when the new agent won't stay up", async () => {
        const { steps, exec } = scripted({ withLauncher: true, came: undefined });
        await upgrade(exec, "1.0.0");
        expect(steps.slice(-3)).toEqual([`swap ${previous} → ${agentPath}`, `swap ${launcherPrevious} → ${launcherPath}`, `restart`]);
    });

    it("touches neither when either download fails", async () => {
        const { steps, exec } = scripted({
            withLauncher: true,
            fetchTo: async (url) => (url.includes("intentic-launch") ? Promise.reject(new Error("socket hang up")) : undefined),
        });
        expect((await upgrade(exec, "1.0.0")).kind).toBe("failed");
        expect(steps.some((step) => step.startsWith("swap"))).toBe(false);
    });
});

// A binary can land without the agent noticing (a re-run, a copy dropped in), and the agent keeps its started build.
describe("runUpgrade reconciles the running agent", () => {
    it("restarts an agent that is behind the installed binary, without downloading anything", async () => {
        const { steps, exec } = scripted({ running: "0.9.0", came: TARGET });
        expect(await upgrade(exec, TARGET)).toEqual({ kind: "restarted", from: "0.9.0", to: TARGET });
        expect(steps).toEqual(["restart"]);
    });

    it("leaves an agent already on the installed build strictly alone", async () => {
        const { steps, exec } = scripted({ running: TARGET });
        expect(await upgrade(exec, TARGET)).toEqual({ kind: "current", version: TARGET });
        expect(steps).toEqual([]);
    });

    it("starts nothing when no agent is running at all", async () => {
        const { steps, exec } = scripted({ running: undefined });
        expect(await upgrade(exec, TARGET)).toEqual({ kind: "current", version: TARGET });
        expect(steps).toEqual([]);
    });

    it("says which build is still serving when the restart doesn't take", async () => {
        const { exec } = scripted({ running: "0.9.0", came: "0.9.0" });
        const outcome = await upgrade(exec, TARGET);
        expect(outcome).toEqual({ kind: "agent-behind", installed: TARGET, running: "0.9.0" });
        expect(upgradeMessage(outcome)).toContain("intentic-machine run --stop");
    });

    it("says nothing came back when the restart leaves the machine unserved", async () => {
        const { exec } = scripted({ running: "0.9.0", came: undefined });
        const outcome = await upgrade(exec, TARGET);
        expect(outcome).toEqual({ kind: "agent-behind", installed: TARGET });
        expect(upgradeMessage(outcome)).toContain("didn't come back up");
    });
});

// Upgrade is a direction: a machine already past the release asked for keeps what it stands on.
describe("runUpgrade never moves a machine backwards", () => {
    it("declines a release older than the one installed, downloading nothing", async () => {
        const { steps, exec } = scripted({ running: "2.5.0" });
        expect(await upgrade(exec, "2.5.0", TARGET)).toEqual({ kind: "current", version: "2.5.0" });
        expect(steps).toEqual([]);
    });

    // A from-source build carries the dev sentinel, which every release outranks numerically.
    it("leaves a build made from source alone, and says how to replace it on purpose", async () => {
        const { steps, exec } = scripted();
        const outcome = await upgrade(exec, "0.0.0");
        expect(outcome.kind).toBe("current");
        expect(upgradeMessage(outcome)).toContain("--force");
        expect(steps).toEqual([]);
    });

    it("replaces a build made from source when asked to", async () => {
        const { exec } = scripted();
        expect(await upgrade(exec, "0.0.0", TARGET, true)).toEqual({ kind: "upgraded", from: "0.0.0", to: TARGET });
    });
});
