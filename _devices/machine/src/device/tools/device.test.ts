import { DesktopError } from "@intentic/desktop-automation";
import type { DeviceScopes } from "@intentic/sandbox-contract";
import { test, expect, jest } from "bun:test";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { type Caller, calling, createIndicator, type Indicator, PAUSE_HOTKEY } from "../indicator.js";
import { ScopeError } from "../policy.js";
import { fakeDesktop, fakeIndicatorDeps } from "../testing.js";
import { act, type DeviceInput, describeAction } from "./device.js";

/* The policy half of GUI control, driven against a fake desktop and an indicator over fakes, so no test here reads
   this machine's own pause or opens a notice on its screen. */

const scopes = (overrides: Partial<DeviceScopes> = {}): DeviceScopes => ({
    shell: "on",
    write: "on",
    screen: "on",
    control: "on",
    sandboxes: "on",
    destructive: "on",
    ...overrides,
});

const indicator = (): Indicator => createIndicator(fakeIndicatorDeps().deps);

test("every action is refused when the machine may not be driven, before anything is put on its screen", async () => {
    const { desktop, calls } = fakeDesktop();
    const fake = fakeIndicatorDeps();
    await expect(
        act(desktop, { action: "left_click", coordinate: [10, 10] }, scopes({ control: "off" }), createIndicator(fake.deps)),
    ).rejects.toThrow(ScopeError);
    await expect(act(desktop, { action: "type", text: "hello" }, scopes({ control: "off" }), createIndicator(fake.deps))).rejects.toThrow(
        /mouse and keyboard/,
    );
    expect(calls).toEqual([]);
    expect(fake.helpers).toEqual([]);
});

// Seeing and touching are separate grants: a machine may be driven without being watched, and vice versa.
test("control does not require the screen grant", async () => {
    const { desktop, calls } = fakeDesktop();
    await act(desktop, { action: "left_click", coordinate: [4, 5] }, scopes({ screen: "off" }), indicator());
    expect(calls).toEqual(["click left 4,5"]);
});

test("each action reaches the matching desktop method", async () => {
    const { desktop, calls } = fakeDesktop();
    await act(desktop, { action: "mouse_move", coordinate: [1, 2] }, scopes(), indicator());
    await act(desktop, { action: "left_click", coordinate: [3, 4] }, scopes(), indicator());
    await act(desktop, { action: "right_click", coordinate: [5, 6] }, scopes(), indicator());
    await act(desktop, { action: "middle_click", coordinate: [7, 8] }, scopes(), indicator());
    await act(desktop, { action: "double_click", coordinate: [9, 10] }, scopes(), indicator());
    await act(desktop, { action: "left_click_drag", coordinate: [1, 1], to: [2, 2] }, scopes(), indicator());
    await act(desktop, { action: "type", text: "hi" }, scopes(), indicator());
    await act(desktop, { action: "key", text: "ctrl+c" }, scopes(), indicator());
    await act(desktop, { action: "scroll", coordinate: [5, 5], direction: "up", amount: 2 }, scopes(), indicator());
    expect(calls).toEqual([
        "move 1,2",
        "click left 3,4",
        "click right 5,6",
        "click middle 7,8",
        "double 9,10",
        "drag 1,1->2,2",
        "type hi",
        "key ctrl+c",
        "scroll up 2 @5,5",
    ]);
});

/* Refused, not clamped. */
test("a coordinate outside the screen is refused, and says how big the screen is", async () => {
    const { desktop, calls } = fakeDesktop();
    await expect(act(desktop, { action: "left_click", coordinate: [1920, 500] }, scopes(), indicator())).rejects.toThrow(
        /outside the screen.*1920×1080/s,
    );
    await expect(act(desktop, { action: "left_click", coordinate: [-1, 5] }, scopes(), indicator())).rejects.toThrow(DesktopError);
    expect(calls).toEqual([]);
});

test("a drag is checked at both ends", async () => {
    const { desktop, calls } = fakeDesktop();
    await expect(act(desktop, { action: "left_click_drag", coordinate: [10, 10], to: [9000, 10] }, scopes(), indicator())).rejects.toThrow(
        /drag target/,
    );
    expect(calls).toEqual([]);
});

test("pointer actions need a coordinate, and say so in the tool's own words", async () => {
    const { desktop } = fakeDesktop();
    await expect(act(desktop, { action: "left_click" }, scopes(), indicator())).rejects.toThrow(/\[x, y\] in screenshot pixels/);
    await expect(act(desktop, { action: "type" }, scopes(), indicator())).rejects.toThrow(/"text" is required/);
    await expect(act(desktop, { action: "key", text: "" }, scopes(), indicator())).rejects.toThrow(/Return.*ctrl\+c/);
});

test("wait is bounded, so a mis-typed number cannot hold the machine", async () => {
    jest.useFakeTimers();
    try {
        const { desktop } = fakeDesktop();
        const pending = act(desktop, { action: "wait", ms: 600_000 }, scopes(), indicator());
        await advanceTimersByTimeAsync(10_000);
        await expect(pending).resolves.toBeUndefined();
    } finally {
        jest.useRealTimers();
    }
});

// The transcript records what happened; the text itself is the user's business, not the log's.
test("what gets reported names the action but never echoes typed text", () => {
    expect(describeAction({ action: "type", text: "hunter2" })).toBe("Typed 7 characters.");
    expect(describeAction({ action: "type", text: "hunter2" })).not.toContain("hunter2");
    expect(describeAction({ action: "key", text: "ctrl+c" })).toBe("Pressed ctrl+c.");
    expect(describeAction({ action: "left_click", coordinate: [4, 2] })).toBe("left click at (4, 2).");
});

// Every action that moves the pointer or presses a key, each one well-formed.
const INPUTS: readonly DeviceInput[] = [
    { action: "mouse_move", coordinate: [1, 2] },
    { action: "left_click", coordinate: [3, 4] },
    { action: "right_click", coordinate: [5, 6] },
    { action: "middle_click", coordinate: [7, 8] },
    { action: "double_click", coordinate: [9, 10] },
    { action: "left_click_drag", coordinate: [1, 1], to: [2, 2] },
    { action: "type", text: "hi" },
    { action: "key", text: "ctrl+c" },
    { action: "scroll", coordinate: [5, 5], direction: "up", amount: 2 },
];

const ALPHA: Caller = { sandboxUrl: "https://alpha.example.dev", log: () => undefined };

test("an input action is put on the machine's own screen first, under the name of the link that sent it", async () => {
    const { desktop, calls } = fakeDesktop();
    const fake = fakeIndicatorDeps();
    await calling.run(ALPHA, async () => await act(desktop, { action: "left_click", coordinate: [3, 4] }, scopes(), createIndicator(fake.deps)));
    expect(fake.helpers.map((helper) => helper.shown)).toEqual([
        [`Intentic agent is controlling this computer · alpha.example.dev · ${PAUSE_HOTKEY} pauses`],
    ]);
    expect(calls).toEqual(["click left 3,4"]);
});

test("while the person at the machine has paused, every input action is refused in their words and none reaches the desktop", async () => {
    const { desktop, calls } = fakeDesktop();
    const paused = createIndicator(fakeIndicatorDeps({ paused: true }).deps);
    await Promise.all(
        INPUTS.map(
            async (input) => await expect(act(desktop, input, scopes(), paused)).rejects.toThrow(/^Refused: paused by the person at this computer: /),
        ),
    );
    expect(calls).toEqual([]);
});

// A wait moves nothing, and it is how an agent refused by a pause can wait for the person.
test("wait is not input: it is neither shown nor refused while paused", async () => {
    jest.useFakeTimers();
    try {
        const { desktop } = fakeDesktop();
        const fake = fakeIndicatorDeps({ paused: true });
        const pending = act(desktop, { action: "wait", ms: 1_000 }, scopes(), createIndicator(fake.deps));
        await advanceTimersByTimeAsync(1_000);
        await expect(pending).resolves.toBeUndefined();
        expect(fake.helpers).toEqual([]);
    } finally {
        jest.useRealTimers();
    }
});
