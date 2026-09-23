// jsdom for the import chain: the device flow client touches the app's environment at module eval.
import "@intentic/testing/dom";

jest.mock(`../../client/sandboxClient`, () => ({
    sandboxRequest: jest.fn(),
    sandboxJson: jest.fn(),
    sandboxError: jest.fn(),
    // Named by useDevices but never thrown here; bun links an ESM import against exactly what this returns.
    SandboxHttpError: class SandboxHttpError extends Error {},
}));

const { DeviceFlowLostError } = await import("../useDevices");
const { runnerFailure } = await import("./runnerFailure");
const { runnerFallback } = await import("./deviceFallback");

// What `ic runner up` streamed on its way to failing, one line per frame, as the card's log pane holds it.
const streamed = [
    `intentic: building intentic-sandbox-env-runner-omen:a470f481d4d8 from the parent's approved overlay…`,
    `intentic: error: starting the runner failed — the full docker output is saved to C:\\Users\\radar\\.intentic\\logs\\runner-up-20260922-205347.log.`,
    `docker: Error response from daemon: failed to set up container networking: network intentic-workspace-runner-omen not found`,
];
// The machine agent's refusal for that run: its own sentence, a blank line, then every line it streamed (tools/sandboxes.ts).
const refusal = new Error(`That runner start failed on this device.\n\n${streamed.join(`\n`)}`);

it(`names the runner and the machine, and leaves the streamed lines to the pane that already shows them`, () => {
    expect(runnerFailure(`create`, `omen`, `omen`, refusal, streamed)).toEqual({
        notice: { tone: `danger`, title: `Runner "omen" wasn't added to omen.`, detail: `That runner start failed on this device.` },
        command: runnerFallback(`create`, `omen`),
    });
});

it(`keeps a refusal whole when nothing of it was streamed`, () => {
    const switchedOff = new Error(`Refused: "Manage sandboxes on this device" is switched off for this device.`);
    expect(runnerFailure(`remove`, `omen`, `omen`, switchedOff, []).notice.detail).toBe(switchedOff.message);
    expect(runnerFailure(`remove`, `omen`, `omen`, switchedOff, []).command).toBe(runnerFallback(`remove`, `omen`));
});

it(`says a dropped stream is lost contact with a machine that may still be working, quoting the browser`, () => {
    const failure = runnerFailure(`create`, `omen`, `omen`, new DeviceFlowLostError(`BodyStreamBuffer was aborted`), streamed.slice(0, 1));
    expect(failure).toEqual({
        notice: {
            tone: `warning`,
            title: `Lost contact with omen while adding runner "omen".`,
            detail: `It may still be running there: the runner joins this list once it enrolls, and omen keeps a full log of the attempt in ~/.intentic/logs. The browser said: "BodyStreamBuffer was aborted".`,
        },
    });
});

it(`offers no line to type after a drop, since the act may still be finishing`, () => {
    expect(runnerFailure(`remove`, `omen`, `omen`, new DeviceFlowLostError(undefined), []).command).toBeUndefined();
});
