import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { MACHINE_ID_ENV } from "../machine-id.js";
import { childArgv, childEnv, childVerdict, type ChildSpawner, superviseChildren } from "./children.js";
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

const harness = (listed: readonly string[] | undefined = ["archlinux", "Ubuntu"]) => {
    const spawned: { distro: string; child: FakeChild }[] = [];
    const dropped: string[] = [];
    const spawner: ChildSpawner = {
        spawn: (distro) => {
            const child = new FakeChild();
            spawned.push({ distro, child });
            return child as unknown as ChildProcess;
        },
        distros: async () => await Promise.resolve(listed),
        now: () => Date.now(),
    };
    const children = superviseChildren(() => undefined, async (distro) => void dropped.push(distro), spawner);
    return { spawned, dropped, children };
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
