import { setTimeout as sleep } from "node:timers/promises";
import { type Desktop, DesktopError, type MouseButton, type Point, type ScrollDirection } from "./types.js";
import type { Pointing } from "./view.js";

/* One mouse or keyboard action as an agent's tool call spells it, carried out on a desktop. Permission-free: a
   person's own machine checks its switches and its safety rules before calling `perform`, the sandbox's virtual
   desktop checks who holds it. Coordinates are read through a Pointing, so they mean pixels of whichever screenshot
   the agent read them off. */

export type InputAction =
    "mouse_move" | "left_click" | "right_click" | "middle_click" | "double_click" | "left_click_drag" | "type" | "key" | "scroll" | "wait";

export interface InputCall {
    readonly action: InputAction;
    readonly coordinate?: readonly [number, number] | undefined;
    readonly to?: readonly [number, number] | undefined;
    // An element ref, pointed at instead of a coordinate.
    readonly element?: string | undefined;
    readonly text?: string | undefined;
    readonly direction?: ScrollDirection | undefined;
    readonly amount?: number | undefined;
    readonly ms?: number | undefined;
}

// How long the screen is given to catch up before the confirming screenshot. A click that opens a menu needs a
// beat; without it the agent sees the frame before its own action.
export const SETTLE_MS = 400;
// A cap on `wait`, so a mis-typed 600000 cannot hold the machine (and the call) for ten minutes.
export const MAX_WAIT_MS = 10_000;

export const settle = async (): Promise<void> => await sleep(SETTLE_MS);

const point = (value: readonly [number, number] | undefined, name: string): Point => {
    if (value === undefined || value.length !== 2 || !Number.isFinite(value[0]) || !Number.isFinite(value[1])) {
        throw new DesktopError(`"${name}" must be [x, y] in screenshot pixels, or name an element ref instead.`);
    }
    return { x: value[0], y: value[1] };
};

const CLICK_BUTTON = new Map<InputAction, MouseButton>([
    ["left_click", "left"],
    ["right_click", "right"],
    ["middle_click", "middle"],
]);

const where = (input: InputCall): string =>
    input.element === undefined || input.element === "" ? `(${input.coordinate?.join(", ") ?? ""})` : `element ${input.element}`;

// What the machine did, in the words the agent reports back to the user. Text is described by length, never
// echoed: it routinely carries whatever the user asked to be typed.
export const describeInput = (input: InputCall): string => {
    switch (input.action) {
        case "type":
            return `Typed ${input.text?.length ?? 0} characters.`;
        case "key":
            return `Pressed ${input.text ?? ""}.`;
        case "wait":
            return `Waited ${Math.min(input.ms ?? SETTLE_MS, MAX_WAIT_MS)}ms.`;
        case "scroll":
            return `Scrolled ${input.direction ?? "down"} at ${where(input)}.`;
        case "left_click_drag":
            return `Dragged from ${where(input)} to (${input.to?.join(", ") ?? ""}).`;
        default:
            return `${input.action.replace(/_/g, " ")} at ${where(input)}.`;
    }
};

// The text a keyboard action carries, and the sentence that says what a call left out.
export const keyboardText = (action: "type" | "key", text: string | undefined): string => {
    if (text === undefined || text === "") {
        throw new DesktopError(
            action === "type" ? `"text" is required to type.` : `"text" is required to press a key: for example "Return", "ctrl+c", "alt+Tab".`,
        );
    }
    return text;
};

// Where a pointer action starts: the element it names, or its coordinate read through the frame.
const target = async (pointing: Pointing, input: InputCall): Promise<Point> =>
    input.element === undefined || input.element === ""
        ? await pointing.point(point(input.coordinate, "coordinate"), "The coordinate")
        : await pointing.element(input.element);

// Everything that is not a keyboard action is pointer work. The drag target is a coordinate only: an element is
// somewhere to start, and "drop it on that element" is a coordinate the agent can read off the same screenshot.
const pointer = async (screen: Desktop, input: InputCall, pointing: Pointing): Promise<void> => {
    const at = await target(pointing, input);
    switch (input.action) {
        case "mouse_move":
            return await screen.move(at);
        case "double_click":
            return await screen.doubleClick(at);
        case "left_click_drag":
            return await screen.drag(at, await pointing.point(point(input.to, "to"), "The drag target"));
        case "scroll":
            return await screen.scroll(at, input.direction ?? "down", input.amount ?? 3);
        default: {
            const button = CLICK_BUTTON.get(input.action);
            if (button === undefined) {
                throw new DesktopError(`"${input.action}" is not something this desktop can do.`);
            }
            return await screen.click(at, button);
        }
    }
};

// Carries one action out. `wait` is bounded; everything else reaches the desktop.
export const perform = async (screen: Desktop, input: InputCall, pointing: Pointing): Promise<void> => {
    if (input.action === "wait") {
        await sleep(Math.min(Math.max(0, input.ms ?? SETTLE_MS), MAX_WAIT_MS));
        return;
    }
    if (input.action === "type" || input.action === "key") {
        const text = keyboardText(input.action, input.text);
        await (input.action === "type" ? screen.type(text) : screen.key(text));
        return;
    }
    await pointer(screen, input, pointing);
};
