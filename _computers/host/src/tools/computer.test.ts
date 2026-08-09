import { DesktopError } from "@intentic/desktop";
import type { HostScopes } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { ScopeError } from "../policy.js";
import { fakeDesktop } from "../testing.js";
import { act, describeAction } from "./computer.js";

/* The policy half of GUI control, driven against a fake desktop.
 *
 * This is the whole reason the mechanics live in their own package: a real click cannot be asserted on, but
 * "was the click refused", "did the coordinate get checked against the frame" and "did the right method get
 * called" are the parts that decide whether someone's machine does the wrong thing — and they are all here. */

const scopes = (overrides: Partial<HostScopes> = {}): HostScopes => ({
    shell: "on",
    write: "on",
    screen: "on",
    control: "on",
    sandboxes: "on",
    sandboxRemove: "on",
    ...overrides,
});

test("every action is refused when the machine may not be driven", async () => {
    const { desktop, calls } = fakeDesktop();
    await expect(act(desktop, { action: "left_click", coordinate: [10, 10] }, scopes({ control: "off" }))).rejects.toThrow(ScopeError);
    await expect(act(desktop, { action: "type", text: "hello" }, scopes({ control: "off" }))).rejects.toThrow(/mouse and keyboard/);
    expect(calls).toEqual([]);
});

// Seeing and touching are separate grants: a machine may be driven without being watched, and vice versa.
test("control does not require the screen grant", async () => {
    const { desktop, calls } = fakeDesktop();
    await act(desktop, { action: "left_click", coordinate: [4, 5] }, scopes({ screen: "off" }));
    expect(calls).toEqual(["click left 4,5"]);
});

test("each action reaches the matching desktop method", async () => {
    const { desktop, calls } = fakeDesktop();
    await act(desktop, { action: "mouse_move", coordinate: [1, 2] }, scopes());
    await act(desktop, { action: "left_click", coordinate: [3, 4] }, scopes());
    await act(desktop, { action: "right_click", coordinate: [5, 6] }, scopes());
    await act(desktop, { action: "middle_click", coordinate: [7, 8] }, scopes());
    await act(desktop, { action: "double_click", coordinate: [9, 10] }, scopes());
    await act(desktop, { action: "left_click_drag", coordinate: [1, 1], to: [2, 2] }, scopes());
    await act(desktop, { action: "type", text: "hi" }, scopes());
    await act(desktop, { action: "key", text: "ctrl+c" }, scopes());
    await act(desktop, { action: "scroll", coordinate: [5, 5], direction: "up", amount: 2 }, scopes());
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

/* Refused, not clamped. A click 200px past the right edge means the model misread the screenshot; landing it on
 * the edge instead turns a visible mistake into a mysterious one — something got clicked, just not that. */
test("a coordinate outside the screen is refused, and says how big the screen is", async () => {
    const { desktop, calls } = fakeDesktop();
    await expect(act(desktop, { action: "left_click", coordinate: [1920, 500] }, scopes())).rejects.toThrow(/outside the screen.*1920×1080/s);
    await expect(act(desktop, { action: "left_click", coordinate: [-1, 5] }, scopes())).rejects.toThrow(DesktopError);
    expect(calls).toEqual([]);
});

test("a drag is checked at both ends", async () => {
    const { desktop, calls } = fakeDesktop();
    await expect(act(desktop, { action: "left_click_drag", coordinate: [10, 10], to: [9000, 10] }, scopes())).rejects.toThrow(/drag target/);
    expect(calls).toEqual([]);
});

test("pointer actions need a coordinate, and say so in the tool's own words", async () => {
    const { desktop } = fakeDesktop();
    await expect(act(desktop, { action: "left_click" }, scopes())).rejects.toThrow(/\[x, y\] in screenshot pixels/);
    await expect(act(desktop, { action: "type" }, scopes())).rejects.toThrow(/"text" is required/);
    await expect(act(desktop, { action: "key", text: "" }, scopes())).rejects.toThrow(/Return.*ctrl\+c/);
});

test("wait is bounded, so a mis-typed number cannot hold the machine", async () => {
    vi.useFakeTimers();
    try {
        const { desktop } = fakeDesktop();
        const pending = act(desktop, { action: "wait", ms: 600_000 }, scopes());
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(pending).resolves.toBeUndefined();
    } finally {
        vi.useRealTimers();
    }
});

// The transcript records what happened; the text itself is the user's business, not the log's.
test("what gets reported names the action but never echoes typed text", () => {
    expect(describeAction({ action: "type", text: "hunter2" })).toBe("Typed 7 characters.");
    expect(describeAction({ action: "type", text: "hunter2" })).not.toContain("hunter2");
    expect(describeAction({ action: "key", text: "ctrl+c" })).toBe("Pressed ctrl+c.");
    expect(describeAction({ action: "left_click", coordinate: [4, 2] })).toBe("left click at (4, 2).");
});
