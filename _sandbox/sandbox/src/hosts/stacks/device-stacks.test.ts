import type { DeviceStacks, HostStats } from "@intentic/sandbox-contract/schemas/device-stacks";
import { deployDeviceStack, deviceHostStats, deviceStackLogs, deviceStackOp, deviceStacks } from "./device-stacks.js";
import { STACK_DEVICE, stackDevice } from "./device-stacks.testing.js";

// The stack routes' relay to a computer's own tools: what reaches the machine, and how each way a call can end reads to
// the board. Nothing here touches git or the disk; the deploy's packing is device-stacks.integration.test.ts's.

const LISTED: DeviceStacks = {
    root: "/home/me/.intentic/stacks",
    stacks: [
        {
            name: "shop",
            status: "running(2)",
            configFiles: ["/home/me/.intentic/stacks/shop/compose.yaml"],
            workingDir: "/home/me/.intentic/stacks/shop",
            managed: true,
            sandbox: false,
            services: [
                { service: "web", container: "shop-web-1", image: "shop-web", state: "running", status: "Up 3 hours (healthy)", health: "healthy" },
                { service: "db", container: "shop-db-1", image: "postgres:17", state: "running", status: "Up 3 hours" },
            ],
        },
    ],
};

const OFFLINE = `"${STACK_DEVICE}" is not connected right now: the device is asleep, offline, or its agent isn't running.`;
const TOO_OLD_FOR_STACKS = `The agent on "${STACK_DEVICE}" is too old to read or drive Docker compose stacks: update it there (\`intentic-machine upgrade\`, or Update on its Devices card), then try again.`;

const everyCall = (services: ReturnType<typeof stackDevice>["services"]) => [
    () => deviceStacks(services, STACK_DEVICE),
    () => deviceStackOp(services, { id: STACK_DEVICE, name: "shop", op: "restart" }),
    () => deviceStackLogs(services, { id: STACK_DEVICE, name: "shop" }),
    () => deployDeviceStack(services, { id: STACK_DEVICE, name: "shop", repo: "shop" }),
];

test("a computer that is not connected is refused in the hub's own words, and nothing is asked of it", async () => {
    const { services, tools, staging } = stackDevice({ online: false });
    for (const call of everyCall(services)) {
        await expect(call()).rejects.toMatchObject({ code: "CONFLICT", message: OFFLINE });
    }
    expect(tools).toEqual([]);
    expect(staging).toEqual([]);
});

test("an agent too old to have the stack tools is refused before anything is asked, saying how to update it", async () => {
    const { services, tools, staging } = stackDevice({ features: ["programs"] });
    for (const call of everyCall(services)) {
        await expect(call()).rejects.toMatchObject({ code: "CONFLICT", message: TOO_OLD_FOR_STACKS });
    }
    expect(tools).toEqual([]);
    expect(staging).toEqual([]);
});

test("a deploy also needs the agent to take what this sandbox sends, and is refused before any packing without it", async () => {
    const { services, staging } = stackDevice({ features: ["stacks"] });
    await expect(deployDeviceStack(services, { id: STACK_DEVICE, name: "shop", repo: "shop" })).rejects.toMatchObject({
        code: "CONFLICT",
        message: `The agent on "${STACK_DEVICE}" is too old to receive what this sandbox sends: update it there (\`intentic-machine upgrade\`, or Update on its Devices card), then try again.`,
    });
    expect(staging).toEqual([]);
});

test("the machine's refusal reaches the board as FORBIDDEN, in the machine's own words", async () => {
    const said = 'Docker compose stacks need "Run commands" switched on for this sandbox on rog.';
    const { services } = stackDevice({ tool: async () => ({ text: said, refused: true }) });
    await expect(deviceStacks(services, STACK_DEVICE)).rejects.toMatchObject({ code: "FORBIDDEN", message: said });
    await expect(deviceStackOp(services, { id: STACK_DEVICE, name: "shop", op: "up" })).rejects.toMatchObject({ code: "FORBIDDEN", message: said });
    await expect(deviceStackLogs(services, { id: STACK_DEVICE, name: "shop", tail: 10 })).rejects.toMatchObject({ code: "FORBIDDEN", message: said });
});

test("a list is read against the contract's shape and answered as the machine gave it", async () => {
    const { services, tools } = stackDevice({ tool: async () => ({ text: JSON.stringify(LISTED) }) });
    expect(await deviceStacks(services, STACK_DEVICE)).toEqual(LISTED);
    expect(tools.map(({ tool, args }) => ({ tool, args }))).toEqual([{ tool: "list_stacks", args: {} }]);
    expect(tools[0]?.signal?.aborted).toBe(false);
});

test("a list that is not what list_stacks promises is a bad gateway that quotes what came back", async () => {
    const rootless = stackDevice({ tool: async () => ({ text: JSON.stringify({ stacks: [] }) }) });
    await expect(deviceStacks(rootless.services, STACK_DEVICE)).rejects.toMatchObject({
        code: "BAD_GATEWAY",
        message: `"${STACK_DEVICE}" answered list_stacks with something other than what it promises: "{\\"stacks\\":[]}"`,
    });
    const prose = stackDevice({ tool: async () => ({ text: "docker: command not found" }) });
    await expect(deviceStacks(prose.services, STACK_DEVICE)).rejects.toMatchObject({
        code: "BAD_GATEWAY",
        message: `"${STACK_DEVICE}" answered list_stacks with something other than what it promises: "docker: command not found"`,
    });
    const silent = stackDevice({ tool: async () => ({ text: "" }) });
    await expect(deviceStacks(silent.services, STACK_DEVICE)).rejects.toMatchObject({
        code: "BAD_GATEWAY",
        message: `"${STACK_DEVICE}" answered list_stacks with something other than what it promises: nothing`,
    });
});

test("an op is relayed as the stack's name and the op, and answers what compose printed", async () => {
    const printed = " Container shop-web-1  Restarting\n Container shop-web-1  Started\n";
    const { services, tools } = stackDevice({ tool: async () => ({ text: printed }) });
    expect(await deviceStackOp(services, { id: STACK_DEVICE, name: "shop", op: "pull" })).toEqual({ output: printed });
    expect(tools.map(({ tool, args }) => ({ tool, args }))).toEqual([{ tool: "stack_action", args: { name: "shop", op: "pull" } }]);
});

test("logs ask for a tail only when the caller named one", async () => {
    const { services, tools } = stackDevice({ tool: async () => ({ text: "web-1  | listening on :3000\n" }) });
    expect(await deviceStackLogs(services, { id: STACK_DEVICE, name: "shop" })).toEqual({ text: "web-1  | listening on :3000\n" });
    await deviceStackLogs(services, { id: STACK_DEVICE, name: "shop", tail: 50 });
    expect(tools.map(({ tool, args }) => ({ tool, args }))).toEqual([
        { tool: "stack_logs", args: { name: "shop" } },
        { tool: "stack_logs", args: { name: "shop", tail: 50 } },
    ]);
});

test("a link that fails under the call is a bad gateway, said as what it means for the call", async () => {
    const { services } = stackDevice({
        tool: async () => {
            throw new Error("WebSocket is not open: readyState 3 (CLOSED)");
        },
    });
    await expect(deviceStackOp(services, { id: STACK_DEVICE, name: "shop", op: "stop" })).rejects.toMatchObject({
        code: "BAD_GATEWAY",
        message: `"${STACK_DEVICE}" dropped its connection while the stack_action call was running (the device went to sleep, lost its network, or its agent restarted). It may or may not have finished there: check before running it again.`,
    });
});

// (2026-11-25) How full the computer is, for the Deployments extension's monitor: relayed as `host_stats` answers it.
const STATS: HostStats = {
    disks: [{ role: "docker", path: "/var/lib/docker", totalBytes: 500e9, freeBytes: 20e9 }],
    memory: { totalBytes: 16e9, availableBytes: 3e9 },
    load: [0.5, 0.75, 1],
    cpus: 8,
};

test("host stats are relayed as host_stats answers them, and an agent without them is refused before it is asked", async () => {
    const { services, tools } = stackDevice({ features: ["stacks", "host-stats"], tool: async () => ({ text: JSON.stringify(STATS) }) });
    expect(await deviceHostStats(services, STACK_DEVICE)).toEqual(STATS);
    expect(tools.map(({ tool, args }) => ({ tool, args }))).toEqual([{ tool: "host_stats", args: {} }]);
    const older = stackDevice({ features: ["stacks"] });
    await expect(deviceHostStats(older.services, STACK_DEVICE)).rejects.toMatchObject({
        code: "CONFLICT",
        message: `The agent on "${STACK_DEVICE}" is too old to say how full its disks and memory are: update it there (\`intentic-machine upgrade\`, or Update on its Devices card), then try again.`,
    });
    expect(older.tools).toEqual([]);
});
