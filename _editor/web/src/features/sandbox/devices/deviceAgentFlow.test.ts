// jsdom for the import chain: the stream reader touches the app's environment and the per-origin stream budget
// at module eval.
// Both agent ops (update, restart) stop the process carrying the request, so the stream always ends with no
// terminal frame. Pinned here: a silent end is success, a refusal is thrown, and a completed run is quoted.
import "@intentic/testing/dom";
import type { DeviceFlowLine } from "@intentic/sandbox-contract";
import { AsyncIteratorClass } from "@orpc/client";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import { SandboxHttpError } from "../client/sandboxHttpError";
import type { SandboxRpc } from "../client/sandboxRpc";

// The typed client is the whole environment this module needs; the raw client is mocked too since the module reaches
// for it at import time.
const flow = jest.fn<SandboxRpc[`system`][`runDeviceAgentFlow`]>();
jest.mock(`../client/sandboxRpc`, () => ({ sandboxRpc: fakeSandboxRpc({ system: { runDeviceAgentFlow: flow } }) }));
jest.mock(`../client/sandboxClient`, () => ({ sandboxJson: jest.fn(), sandboxRequest: jest.fn(), sandboxError: jest.fn() }));

const { runDeviceAgentFlow } = await import("./useDevices");

// The daemon's frames as the typed client hands them over, the same shape the sandbox flow reads, ending cleanly.
const streams = (frames: readonly DeviceFlowLine[]): void => {
    flow.mockImplementation(async () => {
        let at = 0;
        return new AsyncIteratorClass<DeviceFlowLine, unknown, void>(
            async () => {
                const frame = frames[at++];
                return frame === undefined ? { done: true, value: undefined } : { done: false, value: frame };
            },
            async () => undefined,
        );
    });
};

// Resolves unsettled: the caller words it as "restarting…" rather than claiming an outcome nobody witnessed.
it(`treats a stream that stops mid-sentence as this call's ordinary ending`, async () => {
    streams([
        { kind: `line`, text: `Updating the agent on this device (currently 1.243.0).` },
        { kind: `line`, text: `Started upgrade (pid 8123), detached from this connection.` },
    ]);
    const seen: string[] = [];
    const result = await runDeviceAgentFlow(`my-pc`, `upgrade`, { onLine: (line) => seen.push(line) });
    expect(result).toEqual({ message: undefined, settled: false });
    expect(seen).toEqual([`Updating the agent on this device (currently 1.243.0).`, `Started upgrade (pid 8123), detached from this connection.`]);
    expect(flow).toHaveBeenLastCalledWith({ id: `my-pc`, op: `upgrade` });
});

// A refusal names something the reader can act on, so it's thrown rather than swallowed as a lost connection.
it(`throws the device's own words when it refuses`, async () => {
    streams([{ kind: `error`, message: `"Run commands" is off for this device.` }]);
    await expect(runDeviceAgentFlow(`my-pc`, `restart`)).rejects.toThrow(`"Run commands" is off for this device.`);
    expect(flow).toHaveBeenLastCalledWith({ id: `my-pc`, op: `restart` });
});

it(`comes back settled when the device got to say how it went`, async () => {
    streams([
        { kind: `line`, text: `Restarting this device's agent loop.` },
        { kind: `result`, message: `The agent loop was restarted on this device.` },
    ]);
    await expect(runDeviceAgentFlow(`my-pc`, `restart`)).resolves.toEqual({
        message: `The agent loop was restarted on this device.`,
        settled: true,
    });
});

it(`fails outright when the daemon would not open the stream`, async () => {
    flow.mockRejectedValue(new SandboxHttpError(502, `Request failed (502).`));
    await expect(runDeviceAgentFlow(`my-pc`, `upgrade`)).rejects.toThrow(`Request failed (502).`);
});
