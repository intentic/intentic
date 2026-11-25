import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ListenerMessage } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import type { HostStats, StackSpecInput } from "@intentic/sandbox-contract/schemas/deploys";
import type { DeviceStack } from "@intentic/sandbox-contract/schemas/device-stacks";
import { createMonitor, hostStepped, stackHealthOf } from "./deploy-monitor.js";
import { listedStack, stackMachine, stackRepo, watchFixture, type WatchFixtureOptions } from "./deploys.testing.js";

// The monitor (deploy-monitor.ts) against real git and the fake computer: how a stack's containers read as its state,
// that the owner hears of a stack only once it held a state for two reads and never while it deploys, that a restart
// tells nothing twice, and that a server running low is told once per episode.

let root: string;
let state: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "intentic-deploy-monitor-work-"));
    state = await mkdtemp(join(tmpdir(), "intentic-deploy-monitor-state-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
});

const WEB: StackSpecInput = { name: "web", device: "rog" };

type Service = DeviceStack["services"][number];
const service = (over: Partial<Service> = {}): Service => ({ service: "web", container: "web-web-1", image: "ghcr.io/o/web:main", state: "running", status: "Up 3 hours", ...over });
const RUNNING = [service({ health: "healthy" })];
const UNHEALTHY = [service({ status: "Up 3 hours (unhealthy)", health: "unhealthy" })];

const told = (messages: readonly ListenerMessage[]): string[] =>
    messages.filter((message) => message.type.startsWith("stack_") || message.type.startsWith("host_")).map((message) => `${message.type} ${message.channelId}`);

// A deployed `web` on the fake computer whose listed services a test sets, and a monitor over it on a clock it moves.
interface Listed {
    services: Service[];
    owner?: DeviceStack["owner"];
}

const deployedWeb = async (over: WatchFixtureOptions = {}) => {
    const listed: Listed = { services: [...RUNNING] };
    const fixture = watchFixture(root, state, { tool: stackMachine({ stacks: () => [listedStack("web", listed.services, listed.owner)] }), ...over });
    const clock = { now: Date.parse("2026-11-25T12:00:00.000Z") };
    const monitor = createMonitor({ ...fixture.watchDeps, now: () => clock.now });
    // Each read a minute after the last.
    const read = async (services: readonly Service[]): Promise<void> => {
        listed.services = [...services];
        clock.now += 60_000;
        await monitor.readStacks();
    };
    return { ...fixture, listed, monitor, read, clock };
};

test("a stack's containers read as its state", () => {
    const stack = (services: readonly Service[]): DeviceStack => listedStack("web", [...services]);
    expect(stackHealthOf(undefined)).toBe("missing");
    expect(stackHealthOf(stack(RUNNING))).toBe("running");
    expect(stackHealthOf(stack(UNHEALTHY))).toBe("unhealthy");
    expect(stackHealthOf(stack([service(), service({ service: "db", state: "restarting", status: "Restarting (1) 3 seconds ago" })]))).toBe("restarting");
    expect(stackHealthOf(stack([service({ state: "exited", status: "Exited (0) 2 hours ago" })]))).toBe("stopped");
    expect(stackHealthOf(stack([service(), service({ service: "migrate", state: "exited", status: "Exited (0) 2 hours ago" })]))).toBe("running");
    expect(stackHealthOf(stack([service(), service({ service: "worker", state: "exited", status: "Exited (137) 2 minutes ago" })]))).toBe("unhealthy");
});

test("a stack is told unhealthy once it read so twice, once only, and recovered once it read running twice", async () => {
    await stackRepo(root, "shop", [WEB]);
    const { engine, read, messages, clock } = await deployedWeb();
    await engine.settled((await engine.enqueue({ repo: "shop", stack: "web", trigger: { kind: "manual" } })).id);

    await read(RUNNING);
    await read(UNHEALTHY);
    expect(told(messages)).toEqual([]);
    const brokeAt = new Date(clock.now).toISOString();
    await read(UNHEALTHY);
    expect(told(messages)).toEqual(["stack_unhealthy shop:web"]);
    expect(engine.stackState("shop", "web")).toEqual({ state: "unhealthy", since: brokeAt, ownedElsewhere: false });
    await read(UNHEALTHY);
    await read(RUNNING);
    expect(told(messages)).toEqual(["stack_unhealthy shop:web"]);
    await read(RUNNING);

    expect(told(messages)).toEqual(["stack_unhealthy shop:web", "stack_recovered shop:web"]);
    expect(messages.find((message) => message.type === "stack_unhealthy")).toMatchObject({
        provider: "deploys",
        content: `shop web on rog is unhealthy (a healthcheck failing, or a container stopped beside the others) since ${brokeAt}`,
        extra: { repo: "shop", stack: "web", device: "rog", state: "unhealthy", since: brokeAt },
    });
});

test("a stack the engine is deploying is not told of, and its reads count again from the deploy's end", async () => {
    await stackRepo(root, "shop", [WEB]);
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    let holding = false;
    const { engine, read, messages, listed } = await deployedWeb({
        tool: async (call) => {
            if (call.tool === "deploy_stack" && holding) {
                await held;
            }
            return await stackMachine({ stacks: () => [listedStack("web", listed.services)] })(call);
        },
    });
    await engine.settled((await engine.enqueue({ repo: "shop", stack: "web", trigger: { kind: "manual" } })).id);
    holding = true;
    const deploying = await engine.enqueue({ repo: "shop", stack: "web", trigger: { kind: "manual" } });

    await read(UNHEALTHY);
    await read(UNHEALTHY);
    await read(UNHEALTHY);
    expect(told(messages)).toEqual([]);
    release();
    await engine.settled(deploying.id);
    await read(UNHEALTHY);
    expect(told(messages)).toEqual([]);
    await read(UNHEALTHY);

    expect(told(messages)).toEqual(["stack_unhealthy shop:web"]);
});

test("after a restart, a stack already told unhealthy is not told again, and its recovery still is", async () => {
    await stackRepo(root, "shop", [WEB]);
    const before = await deployedWeb();
    await before.engine.settled((await before.engine.enqueue({ repo: "shop", stack: "web", trigger: { kind: "manual" } })).id);
    await before.read(UNHEALTHY);
    await before.read(UNHEALTHY);
    expect(told(before.messages)).toEqual(["stack_unhealthy shop:web"]);

    const after = await deployedWeb();
    await after.monitor.restore();
    expect(after.engine.stackState("shop", "web").state).toBe("unhealthy");
    await after.read(UNHEALTHY);
    await after.read(UNHEALTHY);
    expect(told(after.messages)).toEqual([]);
    await after.read(RUNNING);
    await after.read(RUNNING);

    expect(told(after.messages)).toEqual(["stack_recovered shop:web"]);
});

test("a stack never deployed from here, or owned by another sandbox there, is read but not told of", async () => {
    await stackRepo(root, "shop", [WEB]);
    const fresh = await deployedWeb();
    await fresh.read(UNHEALTHY);
    await fresh.read(UNHEALTHY);
    expect(fresh.engine.stackState("shop", "web").state).toBe("unhealthy");

    await fresh.engine.settled((await fresh.engine.enqueue({ repo: "shop", stack: "web", trigger: { kind: "manual" } })).id);
    fresh.listed.owner = { sandbox: "https://other.example.dev", you: false };
    await fresh.read(UNHEALTHY);
    await fresh.read(UNHEALTHY);

    expect(fresh.engine.stackState("shop", "web")).toMatchObject({ state: "unhealthy", ownedElsewhere: true });
    expect(told(fresh.messages)).toEqual([]);
});

test("a stack on a computer that is not connected reads unreachable, which tells nothing", async () => {
    await stackRepo(root, "shop", [WEB]);
    const online = await deployedWeb();
    await online.engine.settled((await online.engine.enqueue({ repo: "shop", stack: "web", trigger: { kind: "manual" } })).id);
    const offline = await deployedWeb({ online: false });

    await offline.read(RUNNING);
    await offline.read(RUNNING);
    await offline.read(RUNNING);

    expect(offline.engine.stackState("shop", "web").state).toBe("unreachable");
    expect(told(offline.messages)).toEqual([]);
    expect(offline.tools).toEqual([]);
});

const GIB = 1024 ** 3;
const stats = (free: number, available = 8 * GIB, total = 100 * GIB): HostStats => ({
    disks: [
        { role: "docker", path: "/var/lib/docker", totalBytes: total, freeBytes: free },
        // The stacks folder on the same volume: the same disk, told once.
        { role: "stacks", path: "/home/me/.intentic/stacks", totalBytes: total, freeBytes: free },
    ],
    memory: { totalBytes: 16 * GIB, availableBytes: available },
    load: [0.5, 0.4, 0.3],
    cpus: 4,
});

test("a disk or memory running low is told once per episode, and again only after it was back above the line", () => {
    const steps: string[][] = [];
    let low: string[] = [];
    for (const reading of [stats(30 * GIB), stats(4 * GIB, 0.5 * GIB), stats(11 * GIB, 1 * GIB), stats(9 * GIB, 0.7 * GIB), stats(20 * GIB, 2 * GIB), stats(3 * GIB)]) {
        const step = hostStepped("rog", low, reading);
        low = step.low;
        steps.push(step.events.map((event) => `${event.type} ${event.what}`));
    }
    expect(steps).toEqual([
        [],
        ["host_low_disk /var/lib/docker", "host_low_memory memory"],
        [],
        [],
        [],
        ["host_low_disk /var/lib/docker"],
    ]);
    expect(hostStepped("rog", [], stats(60 * GIB - 1, 8 * GIB, 64 * GIB)).events).toEqual([]);
    expect(hostStepped("rog", [], stats(5 * GIB - 1, 8 * GIB, 1000 * GIB)).events.map((event) => event.type)).toEqual(["host_low_disk"]);
});

test("the servers' pass asks host_stats of a computer hosting a managed stack, and tells a low one once on its device channel", async () => {
    await stackRepo(root, "shop", [WEB]);
    let reading = stats(4 * GIB);
    const fixture = watchFixture(root, state, { tool: stackMachine({ hostStats: () => reading }), features: ["stacks", "programs", "stacks-managed", "host-stats"] });
    const monitor = createMonitor({ ...fixture.watchDeps, now: Date.now });

    await monitor.readHosts();
    await monitor.readHosts();
    reading = stats(50 * GIB);
    await monitor.readHosts();

    expect(fixture.tools.filter((call) => call.tool === "host_stats")).toHaveLength(3);
    expect(told(fixture.messages)).toEqual(["host_low_disk device:rog"]);
    expect(fixture.messages.find((message) => message.type === "host_low_disk")).toMatchObject({
        content: "rog is low on disk /var/lib/docker: 4.0 GiB free of 100.0 GiB (4%)",
        extra: { device: "rog", what: "/var/lib/docker", freeBytes: 4 * GIB, totalBytes: 100 * GIB },
    });
});

test("a computer whose agent cannot say how full it is is not asked", async () => {
    await stackRepo(root, "shop", [WEB]);
    const fixture = watchFixture(root, state, { tool: stackMachine({ hostStats: () => stats(1 * GIB) }) });

    await createMonitor({ ...fixture.watchDeps, now: Date.now }).readHosts();

    expect(fixture.tools).toEqual([]);
    expect(told(fixture.messages)).toEqual([]);
});
