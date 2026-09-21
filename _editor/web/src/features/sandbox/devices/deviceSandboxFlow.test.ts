// @vitest-environment jsdom
// jsdom for the import chain: the stream reader touches the app's environment and the per-origin stream budget
// at module eval.
// A container verb aimed at the sandbox relaying it kills the daemon mid-stream, so the browser sees a dead body
// rather than a result frame. Pinned here: with `severing` that IS the outcome, and a refusal the device managed
// to send is still a failure either way.
import { expect, it, vi } from "vitest";

const requests: { path: string; init?: RequestInit }[] = [];
let answer: () => Response;
vi.mock(`../client/sandboxClient`, () => ({
    sandboxRequest: (path: string, init?: RequestInit) => {
        requests.push({ path, init });
        return Promise.resolve(answer());
    },
    sandboxJson: vi.fn(),
    sandboxError: (response: Response) => Promise.resolve(new Error(`HTTP ${response.status}`)),
}));

const { manageDeviceSandbox } = await import("./useDevices");

// Matches the daemon's wire shape: one `data: <JSON>` SSE frame per line. `dies` plays a container deleted out
// from under the connection carrying its own removal — Chromium's own words for a body that stops arriving.
// One frame per pull rather than a filled queue: a stream that errors with chunks still queued drops them, and the
// ordering under test is precisely "the lines arrived, then the socket went".
const streamOf = (frames: Record<string, unknown>[], dies = false): Response => {
    const encoder = new TextEncoder();
    let at = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            const frame = frames[at++];
            if (frame !== undefined) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
                return;
            }
            if (dies) {
                controller.error(new TypeError(`network error`));
                return;
            }
            controller.close();
        },
    });
    return { ok: true, status: 200, body } as Response;
};

it(`reads a removal whose own success killed the connection as the removal landing`, async () => {
    answer = () => streamOf([{ kind: `line`, text: `Removing intentic-sandbox-work…` }], true);
    const seen: string[] = [];
    await expect(manageDeviceSandbox(`rog`, `work`, `remove`, { severing: true, onLine: (line) => seen.push(line) })).resolves.toBe(
        `Removed "work" from this device: its container, its files and its history are gone.`,
    );
    expect(seen).toEqual([`Removing intentic-sandbox-work…`]);
});

// The daemon can also close cleanly on its way down, which the same call must read the same way.
it(`reads a severing op that simply stops talking the same way`, async () => {
    answer = () => streamOf([{ kind: `line`, text: `Restarting intentic-sandbox-work…` }]);
    await expect(manageDeviceSandbox(`rog`, `work`, `restart`, { severing: true })).resolves.toBe(
        `"work" took this connection down with it, which is what restart does from inside it. What it is now shows up once the page reconnects.`,
    );
});

// A reshape recreates the container, so it severs exactly like a restart does. It was left off that list on the
// reasoning that its own form warns beforehand — a different question from what a dropped stream means — and a
// raise that worked came back as "Lost contact with that device". Both the Devices row and the out-of-memory
// notice send it with `severing`, so both read the drop as the restart they asked for.
it(`reads a reshape's dropped stream as the restart it asked for, not as a failure`, async () => {
    answer = () => streamOf([{ kind: `line`, text: `Recreating intentic-sandbox-work…` }], true);
    await expect(manageDeviceSandbox(`rog`, `work`, `reshape`, { severing: true, resources: { memoryGib: 20 } })).resolves.toBe(
        `"work" took this connection down with it, which is what reshape does from inside it. What it is now shows up once the page reconnects.`,
    );
});

// The ask is the whole point of a reshape, so it has to reach the machine; `severing` still must not.
it(`sends the reshape's ask and keeps the severing hint back`, async () => {
    answer = () => streamOf([{ kind: `result`, message: `Reshaped sandbox "work".` }]);
    await manageDeviceSandbox(`rog`, `work`, `reshape`, { severing: true, resources: { memoryGib: 20 } });
    expect(JSON.parse(String(requests.at(-1)?.init?.body))).toEqual({ id: `rog`, slug: `work`, op: `reshape`, resources: { memoryGib: 20 } });
});

// The machine's own refusal arrives as a frame before anything is severed, so it outranks the severing hint: a
// switch that is off must never read as a container that is gone.
it(`still throws the device's own refusal on a severing op`, async () => {
    answer = () => streamOf([{ kind: `error`, message: `Refused: "Manage sandboxes on this device" is switched off for this device.` }], true);
    await expect(manageDeviceSandbox(`rog`, `work`, `remove`, { severing: true })).rejects.toThrow(
        `Refused: "Manage sandboxes on this device" is switched off for this device.`,
    );
});

// Every other row on the Devices page: a dropped stream there says nothing about what the machine did.
it(`still reports a lost connection for an op that was not aimed at this sandbox`, async () => {
    answer = () => streamOf([{ kind: `line`, text: `Removing intentic-sandbox-other…` }], true);
    await expect(manageDeviceSandbox(`rog`, `other`, `remove`)).rejects.toThrow(TypeError);
    answer = () => streamOf([{ kind: `line`, text: `Removing intentic-sandbox-other…` }]);
    await expect(manageDeviceSandbox(`rog`, `other`, `remove`)).rejects.toThrow(/Lost contact with that device/);
});

it(`quotes the device's own sentence whenever it got to send one`, async () => {
    answer = () => streamOf([{ kind: `result`, message: `Removed sandbox "work" and everything in it.` }]);
    await expect(manageDeviceSandbox(`rog`, `work`, `remove`, { severing: true })).resolves.toBe(`Removed sandbox "work" and everything in it.`);
});

// `severing` is what THIS browser knows about its own connection; the machine has no use for it and its schema
// rejects what it did not ask for.
it(`keeps the severing hint out of what the daemon is sent`, async () => {
    answer = () => streamOf([{ kind: `result`, message: `Removed sandbox "work" and everything in it.` }]);
    await manageDeviceSandbox(`rog`, `work`, `remove`, { severing: true });
    expect(JSON.parse(String(requests.at(-1)?.init?.body))).toEqual({ id: `rog`, slug: `work`, op: `remove` });
});

it(`fails outright when the daemon would not open the stream`, async () => {
    answer = () => ({ ok: false, status: 502, body: null }) as Response;
    await expect(manageDeviceSandbox(`rog`, `work`, `remove`, { severing: true })).rejects.toThrow(`HTTP 502`);
});
