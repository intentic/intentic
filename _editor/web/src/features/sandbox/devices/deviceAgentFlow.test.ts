// @vitest-environment jsdom
// jsdom for the import chain: the stream reader touches the app's environment and the per-origin stream budget
// at module eval.
// Both agent ops (update, restart) stop the process carrying the request, so the stream always ends with no
// terminal frame. Pinned here: a silent end is success, a refusal is thrown, and a completed run is quoted.
import { expect, it, vi } from "vitest";

// The client is the whole environment this module needs; sandboxJson is mocked too since the module reaches
// for it at import time.
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

const { runDeviceAgentFlow } = await import("./useDevices");

// Matches the daemon's wire shape: one `data: <JSON>` SSE frame per line, the same encoder the sandbox flow uses.
const streamOf = (frames: Record<string, unknown>[]): Response => {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            const encoder = new TextEncoder();
            for (const frame of frames) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
            }
            controller.close();
        },
    });
    return { ok: true, status: 200, body } as Response;
};

// Resolves unsettled: the caller words it as "restarting…" rather than claiming an outcome nobody witnessed.
it(`treats a stream that stops mid-sentence as this call's ordinary ending`, async () => {
    answer = () =>
        streamOf([
            { kind: `line`, text: `Updating the agent on this device (currently 1.243.0).` },
            { kind: `line`, text: `Started upgrade (pid 8123), detached from this connection.` },
        ]);
    const seen: string[] = [];
    const result = await runDeviceAgentFlow(`my-pc`, `upgrade`, { onLine: (line) => seen.push(line) });
    expect(result).toEqual({ message: undefined, settled: false });
    expect(seen).toEqual([`Updating the agent on this device (currently 1.243.0).`, `Started upgrade (pid 8123), detached from this connection.`]);
    expect(requests.at(-1)?.path).toBe(`/system/devices/my-pc/agent/upgrade`);
});

// A refusal names something the reader can act on, so it's thrown rather than swallowed as a lost connection.
it(`throws the device's own words when it refuses`, async () => {
    answer = () => streamOf([{ kind: `error`, message: `"Run commands" is off for this device.` }]);
    await expect(runDeviceAgentFlow(`my-pc`, `restart`)).rejects.toThrow(`"Run commands" is off for this device.`);
});

it(`comes back settled when the device got to say how it went`, async () => {
    answer = () => streamOf([{ kind: `line`, text: `Restarting this device's agent loop.` }, { kind: `result`, message: `The agent loop was restarted on this device.` }]);
    await expect(runDeviceAgentFlow(`my-pc`, `restart`)).resolves.toEqual({
        message: `The agent loop was restarted on this device.`,
        settled: true,
    });
});

it(`fails outright when the daemon would not open the stream`, async () => {
    answer = () => ({ ok: false, status: 502, body: null }) as Response;
    await expect(runDeviceAgentFlow(`my-pc`, `upgrade`)).rejects.toThrow(`HTTP 502`);
});
