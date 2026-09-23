// jsdom for the import chain: the stream reader touches the app's environment and the per-origin stream budget
// at module eval.
// A container verb aimed at the sandbox relaying it kills the daemon mid-stream, so the browser sees a dead body
// rather than a result frame. Pinned here: with `severing` that IS the outcome, and a refusal the device managed
// to send is still a failure either way.
import "@intentic/testing/dom";
import type { DeviceFlowLine } from "@intentic/sandbox-contract";
import { AsyncIteratorClass } from "@orpc/client";
import { it, expect, mock } from "bun:test";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import { SandboxHttpError } from "../client/sandboxHttpError";
import type { SandboxRpc } from "../client/sandboxRpc";

const flow = mock<SandboxRpc[`system`][`manageDeviceSandbox`]>();
mock.module(`../client/sandboxRpc`, () => ({ sandboxRpc: fakeSandboxRpc({ system: { manageDeviceSandbox: flow } }) }));
// Named by useDevices for the routes it still reaches raw, none of which runs here; bun links an ESM import against
// exactly what this returns.
mock.module(`../client/sandboxClient`, () => ({ sandboxJson: mock(), sandboxRequest: mock(), sandboxError: mock() }));

const { DeviceFlowLostError, manageDeviceSandbox } = await import("./useDevices");

// The daemon's frames as the typed client hands them over, one per pull. `dies` plays a container deleted out from
// under the connection carrying its own removal — Chromium's own words for a body that stops arriving — once the
// frames are out: the ordering under test is precisely "the lines arrived, then the socket went".
const streams = (frames: readonly DeviceFlowLine[], dies = false, death: Error = new TypeError(`network error`)): void => {
    flow.mockImplementation(async () => {
        let at = 0;
        return new AsyncIteratorClass<DeviceFlowLine, unknown, void>(
            async () => {
                const frame = frames[at++];
                if (frame !== undefined) {
                    return { done: false, value: frame };
                }
                if (dies) {
                    throw death;
                }
                return { done: true, value: undefined };
            },
            async () => undefined,
        );
    });
};

it(`reads a removal whose own success killed the connection as the removal landing`, async () => {
    streams([{ kind: `line`, text: `Removing intentic-sandbox-work…` }], true);
    const seen: string[] = [];
    await expect(manageDeviceSandbox(`rog`, `work`, `remove`, { severing: true, onLine: (line) => seen.push(line) })).resolves.toBe(
        `Removed "work" from this device: its container, its files and its history are gone.`,
    );
    expect(seen).toEqual([`Removing intentic-sandbox-work…`]);
});

// The daemon can also close cleanly on its way down, which the same call must read the same way.
it(`reads a severing op that simply stops talking the same way`, async () => {
    streams([{ kind: `line`, text: `Restarting intentic-sandbox-work…` }]);
    await expect(manageDeviceSandbox(`rog`, `work`, `restart`, { severing: true })).resolves.toBe(
        `"work" took this connection down with it, which is what restart does from inside it. What it is now shows up once the page reconnects.`,
    );
});

// A reshape recreates the container, so it severs exactly like a restart does. It was left off that list on the
// reasoning that its own form warns beforehand — a different question from what a dropped stream means — and a
// raise that worked came back as "Lost contact with that device". Both the Devices row and the out-of-memory
// notice send it with `severing`, so both read the drop as the restart they asked for.
it(`reads a reshape's dropped stream as the restart it asked for, not as a failure`, async () => {
    streams([{ kind: `line`, text: `Recreating intentic-sandbox-work…` }], true);
    await expect(manageDeviceSandbox(`rog`, `work`, `reshape`, { severing: true, resources: { memoryGib: 20 } })).resolves.toBe(
        `"work" took this connection down with it, which is what reshape does from inside it. What it is now shows up once the page reconnects.`,
    );
});

// The ask is the whole point of a reshape, so it has to reach the machine; `severing` still must not.
it(`sends the reshape's ask and keeps the severing hint back`, async () => {
    streams([{ kind: `result`, message: `Reshaped sandbox "work".` }]);
    await manageDeviceSandbox(`rog`, `work`, `reshape`, { severing: true, resources: { memoryGib: 20 } });
    expect(flow).toHaveBeenLastCalledWith({ id: `rog`, slug: `work`, op: `reshape`, resources: { memoryGib: 20 } });
});

// The machine's own refusal arrives as a frame before anything is severed, so it outranks the severing hint: a
// switch that is off must never read as a container that is gone.
it(`still throws the device's own refusal on a severing op`, async () => {
    streams([{ kind: `error`, message: `Refused: "Manage sandboxes on this device" is switched off for this device.` }], true);
    await expect(manageDeviceSandbox(`rog`, `work`, `remove`, { severing: true })).rejects.toThrow(
        `Refused: "Manage sandboxes on this device" is switched off for this device.`,
    );
});

// Every other row on the Devices page: a dropped stream there says nothing about what the machine did, whether the
// socket broke (the browser's words ride along) or merely closed early (nothing to quote).
it(`still reports a lost connection for an op that was not aimed at this sandbox`, async () => {
    streams([{ kind: `line`, text: `Removing intentic-sandbox-other…` }], true);
    const broke = await manageDeviceSandbox(`rog`, `other`, `remove`).catch((error: unknown) => error);
    expect(broke).toBeInstanceOf(DeviceFlowLostError);
    expect((broke as InstanceType<typeof DeviceFlowLostError>).transport).toBe(`network error`);
    expect((broke as Error).message).toBe(
        `Lost contact with that device while this was running: it may still have finished. Refresh to see where it got to. The browser said: "network error".`,
    );
    streams([{ kind: `line`, text: `Removing intentic-sandbox-other…` }]);
    const ended = await manageDeviceSandbox(`rog`, `other`, `remove`).catch((error: unknown) => error);
    expect(ended).toBeInstanceOf(DeviceFlowLostError);
    expect((ended as InstanceType<typeof DeviceFlowLostError>).transport).toBeUndefined();
});

// A body the browser itself aborts mid-flow (Chromium's words below) is the watching ending, not the machine answering.
it(`reads a body the browser aborted mid-flow as lost contact, not as the device's answer`, async () => {
    streams(
        [{ kind: `line`, text: `intentic: building intentic-sandbox-env-runner-omen:a470f481d4d8 from the parent's approved overlay…` }],
        true,
        new DOMException(`BodyStreamBuffer was aborted`, `AbortError`),
    );
    const seen: string[] = [];
    const lost = await manageDeviceSandbox(`omen`, `omen`, `runner-up`, { onLine: (line) => seen.push(line) }).catch((error: unknown) => error);
    expect(lost).toBeInstanceOf(DeviceFlowLostError);
    expect((lost as InstanceType<typeof DeviceFlowLostError>).transport).toBe(`BodyStreamBuffer was aborted`);
    expect(seen).toEqual([`intentic: building intentic-sandbox-env-runner-omen:a470f481d4d8 from the parent's approved overlay…`]);
});

it(`quotes the device's own sentence whenever it got to send one`, async () => {
    streams([{ kind: `result`, message: `Removed sandbox "work" and everything in it.` }]);
    await expect(manageDeviceSandbox(`rog`, `work`, `remove`, { severing: true })).resolves.toBe(`Removed sandbox "work" and everything in it.`);
});

// `severing` is what THIS browser knows about its own connection; the machine has no use for it and its schema
// rejects what it did not ask for.
it(`keeps the severing hint out of what the daemon is sent`, async () => {
    streams([{ kind: `result`, message: `Removed sandbox "work" and everything in it.` }]);
    await manageDeviceSandbox(`rog`, `work`, `remove`, { severing: true });
    expect(flow).toHaveBeenLastCalledWith({ id: `rog`, slug: `work`, op: `remove` });
});

it(`fails outright when the daemon would not open the stream`, async () => {
    flow.mockRejectedValue(new SandboxHttpError(502, `Request failed (502).`));
    await expect(manageDeviceSandbox(`rog`, `work`, `remove`, { severing: true })).rejects.toThrow(`Request failed (502).`);
});
