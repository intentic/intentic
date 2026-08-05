import { type Desktop, DesktopError, type MouseButton, type Point, type ScrollDirection } from "@intentic/desktop";
import type { HostScopes } from "@intentic/sandbox-contract";
import { assertScope } from "../policy.js";

/* GUI work: the tool that lets the agent do the things with no command-line way in — a dialog with an OK button,
 * a native app with no API, a settings pane.
 *
 * THE MECHANICS ARE NOT HERE. @intentic/desktop knows how to move a pointer on Windows and on Wayland; this file
 * knows whether it is ALLOWED to, whether the coordinates make sense, and what to write down afterwards. The
 * split is what makes any of this testable: the package's methods end in a real cursor moving on a real screen
 * and can only be exercised by hand, while everything below takes a Desktop and can be driven by a fake.
 *
 * SEEING AND TOUCHING ARE DIFFERENT PERMISSIONS. `screenshot` is gated on `screen`, every action here on
 * `control`, and neither implies the other: a machine can be watched without being driven, which is the setting
 * most people actually want. The post-action screenshot below needs BOTH, and degrades to text when it only has
 * the one.
 *
 * COORDINATES ARE SCREENSHOT PIXELS. That is the only frame the model has ever seen, so it is the frame the tool
 * accepts; the package puts them back into the OS's space. Out-of-frame coordinates are refused rather than
 * clamped — a click 200px off the right edge is a misread screenshot, and silently landing it on the edge turns
 * a visible mistake into a mysterious one. */

export type ComputerAction =
    "mouse_move" | "left_click" | "right_click" | "middle_click" | "double_click" | "left_click_drag" | "type" | "key" | "scroll" | "wait";

export interface ComputerInput {
    readonly action: ComputerAction;
    readonly coordinate?: readonly [number, number] | undefined;
    readonly to?: readonly [number, number] | undefined;
    readonly text?: string | undefined;
    readonly direction?: ScrollDirection | undefined;
    readonly amount?: number | undefined;
    readonly ms?: number | undefined;
}

// How long the screen is given to catch up before the confirming screenshot. A click that opens a menu needs a
// beat; without it the agent sees the frame BEFORE its own action and concludes nothing happened.
const SETTLE_MS = 400;
// A cap on `wait`, so a mis-typed 600000 cannot hold the machine (and the call) for ten minutes.
const MAX_WAIT_MS = 10_000;

const point = (value: readonly [number, number] | undefined, name: string): Point => {
    if (value === undefined || value.length !== 2 || !Number.isFinite(value[0]) || !Number.isFinite(value[1])) {
        throw new DesktopError(`"${name}" must be [x, y] in screenshot pixels.`);
    }
    return { x: value[0], y: value[1] };
};

const within = (at: Point, frame: { width: number; height: number }, name: string): Point => {
    if (at.x < 0 || at.y < 0 || at.x >= frame.width || at.y >= frame.height) {
        throw new DesktopError(
            `${name} (${at.x}, ${at.y}) is outside the screen, which is ${frame.width}×${frame.height}. Take a screenshot and read the coordinates off it.`,
        );
    }
    return at;
};

const CLICK_BUTTON: Partial<Record<ComputerAction, MouseButton>> = { left_click: "left", right_click: "right", middle_click: "middle" };

// What the machine did, in the words the agent reports back to the user. Text is described by LENGTH, never
// echoed: it routinely carries whatever the user asked to be typed, and this string ends up in a transcript.
export const describeAction = (input: ComputerInput): string => {
    switch (input.action) {
        case "type":
            return `Typed ${input.text?.length ?? 0} characters.`;
        case "key":
            return `Pressed ${input.text ?? ""}.`;
        case "wait":
            return `Waited ${Math.min(input.ms ?? SETTLE_MS, MAX_WAIT_MS)}ms.`;
        case "scroll":
            return `Scrolled ${input.direction ?? "down"} at (${input.coordinate?.join(", ") ?? ""}).`;
        case "left_click_drag":
            return `Dragged from (${input.coordinate?.join(", ") ?? ""}) to (${input.to?.join(", ") ?? ""}).`;
        default:
            return `${input.action.replace(/_/g, " ")} at (${input.coordinate?.join(", ") ?? ""}).`;
    }
};

const sleep = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

// Perform one action. Returns nothing — what the caller reports is describeAction plus, when it may look, a
// fresh screenshot.
export const act = async (screen: Desktop, input: ComputerInput, scopes: HostScopes): Promise<void> => {
    assertScope(scopes, "control");
    if (input.action === "wait") {
        await sleep(Math.min(Math.max(0, input.ms ?? SETTLE_MS), MAX_WAIT_MS));
        return;
    }
    if (input.action === "type") {
        if (input.text === undefined || input.text === "") {
            throw new DesktopError(`"text" is required to type.`);
        }
        await screen.type(input.text);
        return;
    }
    if (input.action === "key") {
        if (input.text === undefined || input.text === "") {
            throw new DesktopError(`"text" is required to press a key — for example "Return", "ctrl+c", "alt+Tab".`);
        }
        await screen.key(input.text);
        return;
    }

    // Everything left is pointer work, so the frame is read once and every coordinate judged against it.
    const frame = await screen.frame();
    const at = within(point(input.coordinate, "coordinate"), frame, "The coordinate");
    if (input.action === "mouse_move") {
        await screen.move(at);
        return;
    }
    if (input.action === "double_click") {
        await screen.doubleClick(at);
        return;
    }
    if (input.action === "left_click_drag") {
        await screen.drag(at, within(point(input.to, "to"), frame, "The drag target"));
        return;
    }
    if (input.action === "scroll") {
        await screen.scroll(at, input.direction ?? "down", input.amount ?? 3);
        return;
    }
    const button = CLICK_BUTTON[input.action];
    if (button === undefined) {
        throw new DesktopError(`"${input.action}" is not something this computer can do.`);
    }
    await screen.click(at, button);
};

// The settle the confirming screenshot needs. Separate from `act` so a caller that does not want the frame (a
// test, a batch of moves) does not pay for it.
export const settle = async (): Promise<void> => await sleep(SETTLE_MS);
