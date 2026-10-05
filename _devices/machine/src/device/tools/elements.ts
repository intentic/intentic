import {
    type Desktop,
    DesktopError,
    type ElementAction,
    elementNow,
    type ElementRefs,
    frameName,
    type FrameLog,
    toImage,
    type UiElement,
    viewFrame,
} from "@intentic/desktop-automation";
import type { DeviceScopes } from "@intentic/sandbox-contract";
import { calling, type Indicator, machineIndicator } from "../indicator.js";
import { assertScope } from "../policy.js";
import { assertTypable } from "./device.js";


/* A window's controls, read from the platform's accessibility tree rather than off its pixels: each has a role, a
   name and a ref, and can be clicked through the pointer or acted on without it (invoke a button, set a field,
   toggle a box). The second works on a window in the background, takes nobody's mouse, and does not depend on a
   coordinate being read right off a shrunk screenshot. Listing needs `screen`; acting needs `control`. */

// Roles a person operates, as roleOf spells them; the rest of a tree is layout.
const OPERABLE = new Set([
    "button",
    "split button",
    "edit",
    "document",
    "check box",
    "radio button",
    "combo box",
    "list item",
    "menu item",
    "tab item",
    "hyperlink",
    "tree item",
    "slider",
    "spinner",
    "data item",
    "header item",
]);

// Past this a listing stops being a list anybody reads; `query` narrows it instead.
const MAX_SHOWN = 150;

// Whether an element earns a line: something a person could operate, with something to call it by.
const operable = (element: UiElement): boolean => {
    const acts = element.actions.some((action) => action !== "focus");
    const named = element.name.trim() !== "" || element.value !== undefined || element.role === "edit";
    return (OPERABLE.has(element.role) || acts) && named;
};

// With a query, every element whose role, name or value contains it, operable or not: asking for "Total" should find
// the label that says it.
const matches = (element: UiElement, query: string): boolean =>
    [element.role, element.name, element.value ?? ""].some((field) => field.toLowerCase().includes(query.toLowerCase()));

const quoted = (text: string): string => JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}…` : text);

export const listElements = async (
    screen: Desktop,
    input: { readonly window?: string | undefined; readonly query?: string | undefined },
    scopes: DeviceScopes,
    refs: ElementRefs,
    log: FrameLog,
): Promise<string> => {
    assertScope(scopes, "screen");
    const tree = await screen.elements(input.window);
    const query = input.query?.trim() ?? "";
    const chosen = tree.elements.filter((element) => (query === "" ? operable(element) : matches(element, query)));
    const shown = chosen.slice(0, MAX_SHOWN);
    const minted = refs.mint(tree.window.id, shown);
    const header =
        `Window [${tree.window.id}] ${quoted(tree.window.title)} (${tree.window.app}): ${ 
        query === "" ? `${chosen.length} controls` : `${chosen.length} elements matching ${quoted(query)}` 
        }${shown.length < chosen.length ? `, the first ${shown.length} shown (pass query to narrow)` : "" 
        }${tree.truncated ? `; the window has more than could be read, so some are missing` : "" 
        }.`;
    if (shown.length === 0) {
        return `${header} ${query === "" ? "This window offers no controls to its accessibility tree; use a screenshot and coordinates instead." : "Try a shorter query, or none."}`;
    }
    const frame = await viewFrame(screen, log);
    const rows = shown.map((element, index) => {
        const placed = element.bounds.width > 0 && element.bounds.height > 0 ? toImage(frame, element.bounds) : undefined;
        const at = placed === undefined ? "position unknown" : `at ${placed.x},${placed.y} ${placed.width}×${placed.height}`;
        const value = element.value === undefined ? "" : ` = ${quoted(element.value)}`;
        const state = [element.focused ? "focused" : "", element.enabled ? "" : "disabled"].filter((word) => word !== "").join(", ");
        const actions = element.actions.join(" ");
        return `${minted[index]} ${element.role} ${quoted(element.name)}${value} ${at}${state === "" ? "" : ` (${state})`}${actions === "" ? "" : ` [${actions}]`}`;
    });
    return [
        header,
        `Positions are pixels in ${frameName(frame)}. Pass a ref as \`element\` to the device tool to click it, or to ui_act to act on it without the pointer. Refs hold until the next listing.`,
        ...rows,
    ].join("\n");
};

const ACTION_WORDS = {
    invoke: "Pressed",
    set_value: "Set",
    toggle: "Toggled",
    expand: "Expanded",
    collapse: "Collapsed",
    select: "Selected",
    focus: "Focused",
} satisfies Record<ElementAction, string>;

// One accessibility action on one element. Text set into a field is held to the same rule as typed text.
export const actOnElement = async (
    screen: Desktop,
    input: { readonly element: string; readonly action: ElementAction; readonly value?: string | undefined },
    scopes: DeviceScopes,
    refs: ElementRefs,
    indicator: Indicator = machineIndicator(),
): Promise<string> => {
    assertScope(scopes, "control");
    if (input.action === "set_value") {
        if (input.value === undefined) {
            throw new DesktopError(`"value" is what set_value writes into the element; pass it, even as "" to clear the field.`);
        }
        assertTypable(input.value, scopes);
    }
    const known = refs.resolve(input.element);
    const { element, described } = await elementNow(screen, refs, input.element);
    if (!element.actions.includes(input.action)) {
        throw new DesktopError(
            `The ${described} (${input.element}) does not offer ${input.action}; it offers ${element.actions.length === 0 ? "nothing but the pointer" : element.actions.join(", ")}.`,
        );
    }
    await indicator.control(calling.getStore());
    await screen.elementAct(known.window, known.id, input.action, input.value);
    const what = input.action === "set_value" ? `${described} to ${input.value?.length ?? 0} characters` : described;
    return `${ACTION_WORDS[input.action]} the ${what} (${input.element}).`;
};
