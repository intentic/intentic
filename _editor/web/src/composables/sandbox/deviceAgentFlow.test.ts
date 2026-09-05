// @vitest-environment jsdom
//
// jsdom for the import chain rather than for a DOM: the stream reader reaches the app's environment and its
// per-origin stream budget, both of which read browser globals at module eval (vitest.setup.ts stands them up).
//
/* THE ONE CALL IN THIS APP THAT EXPECTS TO BE CUT OFF.
 *
 * `runDeviceAgentFlow` asks a device to update or restart its own agent, and both ops stop the process that is
 * carrying the request. So the stream ends with no terminal frame EVERY time, and the sibling flow's rule —
 * no `result` means the connection was lost, throw — would turn the ordinary ending into an error message on
 * a row where nothing went wrong. What is pinned here is that the three endings stay distinguishable: a silent
 * end is success with nothing to report, a device that refuses says so, and a run that got to speak is quoted.
 */
import { expect, it, vi } from "vitest";

// The client is the whole environment this module needs: no window, no daemon, no session. `sandboxJson` is
// mocked too because the module reaches for it at import time (the devices list read next to this one).
const requests: { path: string; init?: RequestInit }[] = [];
let answer: () => Response;
vi.mock(`./sandboxClient`, () => ({
    sandboxRequest: (path: string, init?: RequestInit) => {
        requests.push({ path, init });
        return Promise.resolve(answer());
    },
    sandboxJson: vi.fn(),
    sandboxError: (response: Response) => Promise.resolve(new Error(`HTTP ${response.status}`)),
}));

const { runDeviceAgentFlow } = await import("./useDevices");

/* The daemon's own wire shape for these flows: one `data: <JSON>` SSE frame per line (system.routes.ts streams
 * the agent's lines through the same encoder the sandbox flow uses), so the frames are built the way the
 * daemon builds them rather than the way the reader happens to parse them. */
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

/* THE UPGRADE'S REAL ENDING. The agent narrates until its loop goes down, and the loop going down is what was
 * asked for, so the last thing the reader gets is a half-finished log and no verdict. That resolves, and it
 * resolves UNSETTLED: the caller words it as "restarting…" rather than claiming an outcome nobody witnessed. */
it(`treats a stream that stops mid-sentence as this call's ordinary ending`, async () => {
    answer = () =>
        streamOf([
            { kind: `line`, text: `Updating the agent on this device (currently 1.243.0).` },
            { kind: `line`, text: `Started upgrade (pid 8123), detached from this connection.` },
        ]);
    const seen: string[] = [];
    const result = await runDeviceAgentFlow(`my-pc`, `upgrade`, { onLine: (line) => seen.push(line) });
    expect(result).toEqual({ message: undefined, settled: false });
    // Everything it managed to say still reached the reader: the log pane is the only account of an update that
    // ends this way.
    expect(seen).toEqual([`Updating the agent on this device (currently 1.243.0).`, `Started upgrade (pid 8123), detached from this connection.`]);
    expect(requests.at(-1)?.path).toBe(`/system/devices/my-pc/agent/upgrade`);
});

/* A REFUSAL IS NOT A LOST CONNECTION, and the difference is the whole reason this is not "ignore every ending".
 * The device answering "that switch is off" names something the reader can go and change, so it is thrown with
 * the device's own words rather than swallowed as a stream that happened to end. */
it(`throws the device's own words when it refuses`, async () => {
    answer = () => streamOf([{ kind: `error`, message: `"Run commands" is off for this device.` }]);
    await expect(runDeviceAgentFlow(`my-pc`, `restart`)).rejects.toThrow(`"Run commands" is off for this device.`);
});

// A restart is quick enough that the agent sometimes gets its last line out before the socket goes. When it
// does, that sentence is the device's, and it is the one the row shows.
it(`comes back settled when the device got to say how it went`, async () => {
    answer = () => streamOf([{ kind: `line`, text: `Restarting this device's agent loop.` }, { kind: `result`, message: `The agent loop was restarted on this device.` }]);
    await expect(runDeviceAgentFlow(`my-pc`, `restart`)).resolves.toEqual({
        message: `The agent loop was restarted on this device.`,
        settled: true,
    });
});

// An HTTP failure never reaches the frame reader: nothing on that device was started, so this is the one ending
// that is a plain error with no log behind it.
it(`fails outright when the daemon would not open the stream`, async () => {
    answer = () => ({ ok: false, status: 502, body: null }) as Response;
    await expect(runDeviceAgentFlow(`my-pc`, `upgrade`)).rejects.toThrow(`HTTP 502`);
});
