import { registerDeviceCiRunner, removeDeviceCiRunner } from "../../ci/fleet/runner-registration.js";
import { deviceCiFleet, deviceCiRunnerLogs, deviceCiRunnerOp } from "./device-ci-fleet.js";
import { FLEET, FLEET_DEVICE, fleetDevice, MINTED, RUNNER } from "./device-ci-fleet.testing.js";

// The CI runner routes' relay to a computer's own tools, and the GitHub tokens a removal mints: what reaches the
// machine and GitHub, and how each way a call can end reads to the Pipelines view. A registration resolves a workspace
// repository's remote on disk, so it is device-ci-fleet.integration.test.ts's.

const OFFLINE = `"${FLEET_DEVICE}" is not connected right now: the device is asleep, offline, or its agent isn't running.`;
const TOO_OLD = `The agent on "${FLEET_DEVICE}" is too old to read or drive its CI runners: update it there (\`intentic-machine upgrade\`, or Update on its Devices card), then try again.`;

// The fleet for `ci_runners`, and a plain sentence for every other tool.
const answering = (said = "done") => async (call: { tool: string }) => ({ text: call.tool === "ci_runners" ? JSON.stringify(FLEET) : said });

const everyCall = ({ services, fetchFn }: ReturnType<typeof fleetDevice>) => [
    () => deviceCiFleet(services, FLEET_DEVICE),
    () => deviceCiRunnerOp(services, { id: FLEET_DEVICE, name: RUNNER.name, op: "drain" }),
    () => deviceCiRunnerLogs(services, { id: FLEET_DEVICE, name: RUNNER.name }),
    () => registerDeviceCiRunner(services, { id: FLEET_DEVICE, repo: "web", name: "radarsu-worker-4", labels: ["self-hosted"] }, fetchFn),
    () => removeDeviceCiRunner(services, { id: FLEET_DEVICE, name: RUNNER.name }, fetchFn),
];

test("a computer that is not connected is refused in the hub's own words, and neither it nor GitHub is asked anything", async () => {
    const device = fleetDevice({ online: false });
    for (const call of everyCall(device)) {
        await expect(call()).rejects.toMatchObject({ code: "CONFLICT", message: OFFLINE });
    }
    expect(device.tools).toEqual([]);
    expect(device.mints).toEqual([]);
});

test("an agent too old to advertise ci-runners is refused before anything is asked, saying how to update it", async () => {
    const device = fleetDevice({ features: ["stacks", "programs"] });
    for (const call of everyCall(device)) {
        await expect(call()).rejects.toMatchObject({ code: "CONFLICT", message: TOO_OLD });
    }
    expect(device.tools).toEqual([]);
    expect(device.mints).toEqual([]);
});

test("the machine's refusal reaches the view as FORBIDDEN, in the machine's own words", async () => {
    const said = 'CI runners need "Run commands" switched on for this sandbox on omen.';
    const { services } = fleetDevice({ tool: async () => ({ text: said, refused: true }) });
    await expect(deviceCiFleet(services, FLEET_DEVICE)).rejects.toMatchObject({ code: "FORBIDDEN", message: said });
    await expect(deviceCiRunnerOp(services, { id: FLEET_DEVICE, name: RUNNER.name, op: "stop" })).rejects.toMatchObject({ code: "FORBIDDEN", message: said });
    await expect(deviceCiRunnerLogs(services, { id: FLEET_DEVICE, name: RUNNER.name, tail: 10 })).rejects.toMatchObject({ code: "FORBIDDEN", message: said });
});

test("the fleet is read against the contract's shape and answered as the machine gave it", async () => {
    const { services, tools } = fleetDevice({ tool: answering() });
    expect(await deviceCiFleet(services, FLEET_DEVICE)).toEqual(FLEET);
    expect(tools.map(({ tool, args }) => ({ tool, args }))).toEqual([{ tool: "ci_runners", args: {} }]);
    expect(tools[0]?.signal?.aborted).toBe(false);
});

test("a fleet that is not what ci_runners promises is a bad gateway that quotes what came back", async () => {
    const { services } = fleetDevice({ tool: async () => ({ text: "systemctl: command not found" }) });
    await expect(deviceCiFleet(services, FLEET_DEVICE)).rejects.toMatchObject({
        code: "BAD_GATEWAY",
        message: `"${FLEET_DEVICE}" answered ci_runners with something other than what it promises: "systemctl: command not found"`,
    });
});

test("an op is relayed as the runner's name and the op, and answers the machine's sentence", async () => {
    const said = "radarsu-worker-3 drains: it stops once its job ends.";
    const { services, tools } = fleetDevice({ tool: async () => ({ text: said }) });
    expect(await deviceCiRunnerOp(services, { id: FLEET_DEVICE, name: RUNNER.name, op: "drain" })).toEqual({ said });
    expect(tools.map(({ tool, args }) => ({ tool, args }))).toEqual([{ tool: "ci_runner_action", args: { name: RUNNER.name, op: "drain" } }]);
});

test("logs ask for a tail only when the caller named one", async () => {
    const { services, tools } = fleetDevice({ tool: async () => ({ text: "Listening for Jobs\n" }) });
    expect(await deviceCiRunnerLogs(services, { id: FLEET_DEVICE, name: RUNNER.name })).toEqual({ text: "Listening for Jobs\n" });
    await deviceCiRunnerLogs(services, { id: FLEET_DEVICE, name: RUNNER.name, tail: 50 });
    expect(tools.map(({ tool, args }) => ({ tool, args }))).toEqual([
        { tool: "ci_runner_logs", args: { name: RUNNER.name } },
        { tool: "ci_runner_logs", args: { name: RUNNER.name, tail: 50 } },
    ]);
});

test("a link that fails under the call is a bad gateway, said as what it means for the call", async () => {
    const { services } = fleetDevice({
        tool: async () => {
            throw new Error("WebSocket is not open: readyState 3 (CLOSED)");
        },
    });
    await expect(deviceCiRunnerOp(services, { id: FLEET_DEVICE, name: RUNNER.name, op: "restart" })).rejects.toMatchObject({
        code: "BAD_GATEWAY",
        message: `"${FLEET_DEVICE}" dropped its connection while the ci_runner_action call was running (the device went to sleep, lost its network, or its agent restarted). It may or may not have finished there: check before running it again.`,
    });
});

test("a removal mints a removal token for the repository the runner is registered to, and hands it to the machine alone", async () => {
    const device = fleetDevice({ tool: answering("radarsu-worker-3 removed from acme/web and from this computer.") });
    expect(await removeDeviceCiRunner(device.services, { id: FLEET_DEVICE, name: RUNNER.name }, device.fetchFn)).toEqual({
        said: "radarsu-worker-3 removed from acme/web and from this computer.",
    });
    expect(device.mints).toEqual([
        { url: "https://api.github.com/repos/acme/web/actions/runners/remove-token", method: "POST", authorization: "Bearer ghp_connection" },
    ]);
    expect(device.tools.map(({ tool, args }) => ({ tool, args }))).toEqual([
        { tool: "ci_runners", args: {} },
        { tool: "ci_runner_remove", args: { name: RUNNER.name, token: MINTED } },
    ]);
});

test("an organisation's runner has its removal token minted for the organisation", async () => {
    const fleet = { ...FLEET, runners: [{ ...RUNNER, url: "https://github.com/acme" }] };
    const device = fleetDevice({ tool: async (call) => ({ text: call.tool === "ci_runners" ? JSON.stringify(fleet) : "removed" }) });
    await removeDeviceCiRunner(device.services, { id: FLEET_DEVICE, name: RUNNER.name }, device.fetchFn);
    expect(device.mints.map(({ url }) => url)).toEqual(["https://api.github.com/orgs/acme/actions/runners/remove-token"]);
});

test("a removal of a runner the computer does not have, or one that names no registration, mints nothing", async () => {
    const device = fleetDevice({ tool: answering() });
    await expect(removeDeviceCiRunner(device.services, { id: FLEET_DEVICE, name: "nobody" }, device.fetchFn)).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: `There is no runner "nobody" on "${FLEET_DEVICE}".`,
    });
    const { url: _url, ...unregistered } = RUNNER;
    const bare = fleetDevice({ tool: async () => ({ text: JSON.stringify({ ...FLEET, runners: [unregistered] }) }) });
    await expect(removeDeviceCiRunner(bare.services, { id: FLEET_DEVICE, name: RUNNER.name }, bare.fetchFn)).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: `The runner "${RUNNER.name}" does not say what it is registered to, so no removal token can be minted for it.`,
    });
    expect([...device.mints, ...bare.mints]).toEqual([]);
});

test("with no GitHub connection a removal is refused naming what to connect, and the machine is not asked to remove", async () => {
    const device = fleetDevice({ tool: answering(), github: false });
    await expect(removeDeviceCiRunner(device.services, { id: FLEET_DEVICE, name: RUNNER.name }, device.fetchFn)).rejects.toMatchObject({
        code: "FORBIDDEN",
        message:
            "Removing a runner takes a token GitHub mints for the repository, through this sandbox's GitHub connection, and none is connected: connect GitHub under Capabilities, with an account that has admin on the repository, then try again.",
    });
    expect(device.tools.map(({ tool }) => tool)).toEqual(["ci_runners"]);
    expect(device.mints).toEqual([]);
});

test("a token GitHub refuses is FORBIDDEN naming the admin the connection lacks, and the machine is not asked to remove", async () => {
    const refusal = new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
    const device = fleetDevice({ tool: answering(), mint: async () => refusal });
    const failure = removeDeviceCiRunner(device.services, { id: FLEET_DEVICE, name: RUNNER.name }, device.fetchFn);
    await expect(failure).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: `GitHub refused to mint a runner removal token for https://github.com/acme/web (403): the connected GitHub account needs admin on acme/web (a fine-grained token's "Administration: read and write"). Grant it, or connect an account that has it, then try again.`,
    });
    expect(device.tools.map(({ tool }) => tool)).toEqual(["ci_runners"]);
});

test("a token the connection no longer has is said as a reconnect, and an answer without a token as GitHub's fault", async () => {
    const expired = fleetDevice({ tool: answering(), mint: async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }) });
    await expect(removeDeviceCiRunner(expired.services, { id: FLEET_DEVICE, name: RUNNER.name }, expired.fetchFn)).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "GitHub no longer accepts the connected account's token, so it would not mint a runner removal token for https://github.com/acme/web: reconnect GitHub under Capabilities.",
    });
    const empty = fleetDevice({ tool: answering(), mint: async () => new Response("{}", { status: 201 }) });
    await expect(removeDeviceCiRunner(empty.services, { id: FLEET_DEVICE, name: RUNNER.name }, empty.fetchFn)).rejects.toMatchObject({
        code: "BAD_GATEWAY",
        message: "GitHub answered the remove token request for https://github.com/acme/web without a token.",
    });
});
