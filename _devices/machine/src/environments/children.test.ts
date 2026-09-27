import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { MACHINE_ID_ENV } from "../machine-id.js";
import {
    childArgv,
    childEnv,
    childVerdict,
    type ChildSpawner,
    STOPPED_DISTRO_BACKSTOP_MS,
    STOPPED_DISTRO_POLL_MS,
    superviseChildren,
} from "./children.js";
import { SUPERVISOR_ENV, WINDOWS_SUPERVISOR } from "./machine.js";
import { NO_AGENT_EXIT } from "./crossing.js";

describe("childVerdict", () => {
    // Exit 0 is the distro's agent retiring; bringing it back would run an agent with nothing to serve forever.
    it("lets a child go that retired or has no agent at all", () => {
        expect(childVerdict(0, 60_000, 0).kind).toBe("drop");
        expect(childVerdict(NO_AGENT_EXIT, 60_000, 0).kind).toBe("drop");
    });

    // A restart or an upgrade inside the distro stops its agent with a signal: that is a restart to make now, not a crash.
    it("brings a stopped child straight back, whatever it did before", () => {
        expect(childVerdict(143, 1_000, 4)).toEqual({ kind: "restart", delayMs: 1_000, failures: 0 });
        expect(childVerdict(129, 1_000, 4)).toEqual({ kind: "restart", delayMs: 1_000, failures: 0 });
    });

    it("backs a crash loop off rung by rung, and caps the wait", () => {
        const delays = [0, 1, 2, 3, 4, 5, 9].map((failures) => {
            const verdict = childVerdict(1, 1_000, failures);
            return verdict.kind === "restart" ? verdict.delayMs : undefined;
        });
        expect(delays).toEqual([1_000, 5_000, 15_000, 60_000, 300_000, 300_000, 300_000]);
    });

    // A child that ran for ten minutes and then crashed is a crash, not a loop: it starts from the first rung again.
    it("forgets the ladder after a long healthy run", () => {
        expect(childVerdict(1, 10 * 60_000, 4)).toEqual({ kind: "restart", delayMs: 1_000, failures: 1 });
    });
});

// A distro is an environment of the PC, so its agent is started with the PC's own machine id beside the supervision mark.
test("starts a distro's agent supervised, and on this PC's machine id", () => {
    expect(childEnv("m-0f0e0d0c-0b0a-4908-8706-050403020100")).toEqual({
        [SUPERVISOR_ENV]: WINDOWS_SUPERVISOR,
        [MACHINE_ID_ENV]: "m-0f0e0d0c-0b0a-4908-8706-050403020100",
    });
});

describe("childArgv", () => {
    // The agent is found by the distro's own $HOME and told it is supervised, so it registers no systemd unit of its own.
    it("runs the distro's own agent in the foreground, logging where its status command points", () => {
        const { command, args } = childArgv("archlinux");
        expect(command).toBe("wsl.exe");
        expect(args.slice(0, 7)).toEqual(["-d", "archlinux", "--cd", "~", "--exec", "sh", "-c"]);
        expect(args[7]).toContain(`exec "$a" run --foreground >>"$log" 2>&1`);
        expect(args[7]).toContain(`log="$HOME/.intentic/machine/machine.log"`);
    });
});

// A stand-in wsl.exe session: the test decides when it exits and with what.
class FakeChild extends EventEmitter {
    killed = false;
    kill(): boolean {
        this.killed = true;
        return true;
    }
    exit(code: number | null): void {
        this.emit("exit", code);
    }
}

// `running` is what `wsl -l --running` answers, read afresh on every ask; by default every listed distro is running.
const harness = (listed: readonly string[] | undefined = ["archlinux", "Ubuntu"], running: { now: readonly string[] | undefined } = { now: listed }) => {
    const spawned: { distro: string; child: FakeChild }[] = [];
    const dropped: string[] = [];
    const logged: string[] = [];
    let runningAsks = 0;
    const spawner: ChildSpawner = {
        spawn: (distro) => {
            const child = new FakeChild();
            spawned.push({ distro, child });
            return child as unknown as ChildProcess;
        },
        distros: async () => await Promise.resolve(listed),
        running: async () => {
            runningAsks += 1;
            return await Promise.resolve(running.now);
        },
        now: () => Date.now(),
    };
    const children = superviseChildren((line) => void logged.push(line), async (distro) => void dropped.push(distro), spawner);
    return { spawned, dropped, logged, children, runningAsks: () => runningAsks };
};

describe("superviseChildren", () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it("holds one session per attached distro and lets go of one that is no longer attached", () => {
        const { spawned, children } = harness();
        children.reconcile(["archlinux", "Ubuntu"]);
        children.reconcile(["archlinux", "Ubuntu"]);
        expect(spawned.map((entry) => entry.distro)).toEqual(["archlinux", "Ubuntu"]);

        children.reconcile(["archlinux"]);
        expect(spawned[1]?.child.killed).toBe(true);
        expect(children.held()).toEqual(["archlinux"]);
    });

    it("starts a child again after it stops, on the verdict's delay", async () => {
        jest.useFakeTimers();
        const { spawned, children } = harness();
        children.reconcile(["archlinux"]);
        spawned[0]?.child.exit(143);

        await advanceTimersByTimeAsync(999);
        expect(spawned).toHaveLength(1);
        await advanceTimersByTimeAsync(10);
        expect(spawned).toHaveLength(2);
    });

    it("drops a child that retired, from the registry as well as from what it holds", async () => {
        const { spawned, dropped, children } = harness();
        children.reconcile(["archlinux"]);
        spawned[0]?.child.exit(0);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(dropped).toEqual(["archlinux"]);
        expect(children.held()).toEqual([]);
    });

    // A distro `wsl --unregister`ed away would otherwise be retried on the five-minute rung for ever.
    it("drops a child whose distro WSL no longer has", async () => {
        const { spawned, dropped, children } = harness(["Ubuntu"]);
        children.reconcile(["archlinux"]);
        spawned[0]?.child.exit(1);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(dropped).toEqual(["archlinux"]);
    });

    // WSL that cannot be asked is not WSL saying the distro is gone.
    // The agent died inside a distro that is still up: the ladder, exactly as before.
    it("restarts a crash inside a running distro on the ladder", async () => {
        jest.useFakeTimers();
        const { spawned, logged, children } = harness();
        children.reconcile(["archlinux"]);
        spawned[0]?.child.exit(1);
        await advanceTimersByTimeAsync(1_100);
        expect(spawned).toHaveLength(2);
        expect(logged.at(-1)).toContain("the distro is still running; starting it again in 1s");

        spawned[1]?.child.exit(1);
        await advanceTimersByTimeAsync(4_900);
        expect(spawned).toHaveLength(2);
        await advanceTimersByTimeAsync(200);
        expect(spawned).toHaveLength(3);
    });

    // `wsl --shutdown` before a disk compaction: booting the distro a second later holds its VHDX open, so it waits.
    it("waits on a distro WSL stopped, and starts its agent once something else starts the distro", async () => {
        jest.useFakeTimers();
        const running: { now: readonly string[] | undefined } = { now: ["archlinux"] };
        const { spawned, logged, children } = harness(["archlinux"], running);
        children.reconcile(["archlinux"]);
        running.now = [];
        spawned[0]?.child.exit(1);
        await advanceTimersByTimeAsync(3 * STOPPED_DISTRO_POLL_MS);
        expect(spawned).toHaveLength(1);
        expect(logged.at(-1)).toContain("WSL stopped the distro (its session ended, exit 1); not booting it again from here");

        running.now = ["archlinux"];
        await advanceTimersByTimeAsync(STOPPED_DISTRO_POLL_MS + 100);
        expect(spawned).toHaveLength(2);
        expect(logged.at(-1)).toContain("running again");
        // The backstop went with the wait: nothing more is started when it would have fired.
        await advanceTimersByTimeAsync(STOPPED_DISTRO_BACKSTOP_MS);
        expect(spawned).toHaveLength(2);
    });

    it("boots a stopped distro itself once the backstop runs out", async () => {
        jest.useFakeTimers();
        const { spawned, logged, children } = harness(["archlinux"], { now: [] });
        children.reconcile(["archlinux"]);
        spawned[0]?.child.exit(129);
        await advanceTimersByTimeAsync(STOPPED_DISTRO_BACKSTOP_MS - 100);
        expect(spawned).toHaveLength(1);
        await advanceTimersByTimeAsync(200);
        expect(spawned).toHaveLength(2);
        expect(logged.at(-1)).toContain("nothing started it in 5 min, so booting it from here");
    });

    // A wait that looks while WSL cannot be asked keeps waiting: an unknown answer never boots anything either.
    it("keeps waiting when a look at the running distros comes back empty-handed", async () => {
        jest.useFakeTimers();
        const running: { now: readonly string[] | undefined } = { now: [] };
        const { spawned, children } = harness(["archlinux"], running);
        children.reconcile(["archlinux"]);
        spawned[0]?.child.exit(1);
        await advanceTimersByTimeAsync(100);
        running.now = undefined;
        await advanceTimersByTimeAsync(3 * STOPPED_DISTRO_POLL_MS);
        expect(spawned).toHaveLength(1);
    });

    it("cancels the wait on a stopped distro when it is let go", async () => {
        jest.useFakeTimers();
        const running: { now: readonly string[] | undefined } = { now: [] };
        const { spawned, children, runningAsks } = harness(["archlinux", "Ubuntu"], running);
        children.reconcile(["archlinux"]);
        spawned[0]?.child.exit(1);
        await advanceTimersByTimeAsync(STOPPED_DISTRO_POLL_MS + 100);
        children.reconcile([]);
        const asked = runningAsks();
        running.now = ["archlinux"];
        await advanceTimersByTimeAsync(STOPPED_DISTRO_BACKSTOP_MS + STOPPED_DISTRO_POLL_MS);

        expect(spawned).toHaveLength(1);
        expect(runningAsks()).toBe(asked);
        expect(jest.getTimerCount()).toBe(0);
    });

    it("cancels the wait on a stopped distro when the root stops", async () => {
        jest.useFakeTimers();
        const { spawned, children, runningAsks } = harness(["archlinux"], { now: [] });
        children.reconcile(["archlinux"]);
        spawned[0]?.child.exit(1);
        await advanceTimersByTimeAsync(100);
        children.stopAll();
        const asked = runningAsks();
        await advanceTimersByTimeAsync(STOPPED_DISTRO_BACKSTOP_MS + STOPPED_DISTRO_POLL_MS);

        expect(spawned).toHaveLength(1);
        expect(runningAsks()).toBe(asked);
        expect(jest.getTimerCount()).toBe(0);
    });

    // WSL that cannot say what is running is not WSL saying the distro stopped: today's ladder, not the wait.
    it("restarts on the ladder when WSL cannot say which distros are running", async () => {
        jest.useFakeTimers();
        const { spawned, logged, children } = harness(["archlinux"], { now: undefined });
        children.reconcile(["archlinux"]);
        spawned[0]?.child.exit(1);
        await advanceTimersByTimeAsync(1_100);

        expect(spawned).toHaveLength(2);
        expect(logged.at(-1)).toContain("WSL could not say whether the distro is still running; starting it again in 1s");
    });

    it("keeps a child when WSL cannot be asked which distros exist", async () => {
        jest.useFakeTimers();
        const { spawned, dropped, children } = harness(undefined);
        children.reconcile(["archlinux"]);
        spawned[0]?.child.exit(1);
        await advanceTimersByTimeAsync(1_100);

        expect(dropped).toEqual([]);
        expect(spawned).toHaveLength(2);
    });

    it("stops every session and starts none again once the root is stopping", async () => {
        jest.useFakeTimers();
        const { spawned, children } = harness();
        children.reconcile(["archlinux", "Ubuntu"]);
        children.stopAll();
        spawned[0]?.child.exit(143);
        await advanceTimersByTimeAsync(5_000);

        expect(spawned.every((entry) => entry.child.killed)).toBe(true);
        expect(spawned).toHaveLength(2);
    });
});
