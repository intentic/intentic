import { sleep } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { type AgentControl, armAgentControls, type ControlAction, type ControlChoice, type ControlStateValue } from "@intentic/ui";
import { nextTick } from "vue";
import { z } from "zod";
import type { WebMcpTool } from "./agentDevTools";

// THE KIT'S CONTROLS AS TWO TOOLS: one lists what is on screen, one works it. What @intentic/ui's pickers, segmented
// strips, dialogs and disclosure rows register (composables/agentControls.ts) is read here, named the way a screen reader
// would name it, and changed through each component's own model, as a press would change it. An agent that used to
// snapshot, click a trigger, snapshot again and click a row lists the controls once and sends one step.

// Bounds one answer: a settings page holds a few dozen controls, a model picker a hundred choices.
const CONTROL_LIMIT = 60;
const CHOICE_LIMIT = 30;
// How far up from a control its name is looked for in a row's title: a row's control sits a few wrappers deep.
const ROW_TITLE_DEPTH = 8;

const spaced = (text: string | null | undefined): string => (text ?? ``).replace(/\s+/gu, ` `).trim();

// Case, accents and spacing folded away, so "theme" finds "Theme" and "cafe" finds "Café".
const folded = (text: string): string =>
    spaced(text)
        .normalize(`NFD`)
        .replace(/\p{Mn}/gu, ``)
        .toLowerCase();

const labelledByText = (element: Element): string => {
    const ids = element.getAttribute(`aria-labelledby`)?.split(/\s+/u) ?? [];
    return spaced(ids.map((id) => element.ownerDocument.getElementById(id)?.textContent ?? ``).join(` `));
};

const labelsText = (element: Element): string =>
    `labels` in element && element.labels instanceof NodeList ? spaced(Array.from(element.labels, (label) => label.textContent).join(` `)) : ``;

// A control drawn in a <Row>'s trailing cluster is named by that row's title, the one `[data-row-title]` in the nearest
// wrapper holding any; a wrapper holding several is a group of rows, and naming by it would be a guess.
const rowTitleText = (element: Element): string => {
    let at: Element | null = element;
    for (let depth = 0; at !== null && depth < ROW_TITLE_DEPTH; depth += 1, at = at.parentElement) {
        const titles = at.querySelectorAll(`[data-row-title]`);
        if (titles.length > 1) {
            return ``;
        }
        const [title] = titles;
        if (title !== undefined) {
            return spaced(title.textContent);
        }
    }
    return ``;
};

const nameOf = (control: AgentControl, element: Element | undefined): string => {
    const stated = spaced(control.label?.());
    if (stated !== `` || element === undefined) {
        return stated;
    }
    for (const name of [spaced(element.getAttribute(`aria-label`)), labelledByText(element), labelsText(element), rowTitleText(element)]) {
        if (name !== ``) {
            return name;
        }
    }
    return ``;
};

const onScreen = (element: Element | undefined): boolean =>
    element !== undefined && element.isConnected && element.getClientRects().length > 0 && element.closest(`[inert], [aria-hidden="true"]`) === null;

// The open dialog a control is drawn in, by its title: what tells a dialog's "Theme" from the page's behind it.
const dialogOf = (element: Element | undefined): string => {
    const dialog = element?.closest(`[role="dialog"]`);
    return dialog === null || dialog === undefined ? `` : labelledByText(dialog);
};

/** A control as an agent reads it. */
interface ControlRead {
    readonly ref: string;
    readonly kind: string;
    readonly label: string | null;
    readonly within?: string;
    readonly offScreen?: true;
    readonly state: Readonly<Record<string, ControlStateValue>>;
    readonly choices?: readonly ControlChoice[];
    readonly moreChoices?: number;
    /** Each action by name, with what it takes: `nothing`, `flag` (true or false) or `choice` (a value or its words). */
    readonly actions: Readonly<Record<string, ControlAction[`takes`]>>;
}

interface Located {
    readonly ref: string;
    readonly control: AgentControl;
    readonly element: Element | undefined;
    readonly name: string;
    readonly visible: boolean;
}

const locate = (registry: ReadonlyMap<string, AgentControl>): Located[] =>
    Array.from(registry, ([ref, control]) => {
        const element = control.element() ?? undefined;
        return { ref, control, element, name: nameOf(control, element), visible: onScreen(element) };
    });

const choiceRead = ({ value, label, disabled }: ControlChoice): ControlChoice => ({
    value,
    label,
    ...(disabled === true && { disabled }),
});

const readOf = (located: Located, text: string | undefined): ControlRead => {
    const { ref, control, element, name, visible } = located;
    const within = dialogOf(element);
    const all = control.choices?.() ?? [];
    // Asked for by a choice's words, the control shows those choices: the one that matched is the one wanted.
    const matching = text === undefined || folded(name).includes(text) ? all : all.filter((choice) => folded(choice.label).includes(text));
    const choices = matching.slice(0, CHOICE_LIMIT).map(choiceRead);
    return {
        ref,
        kind: control.kind,
        label: name === `` ? null : name,
        ...(within !== `` && within !== name && { within }),
        ...(!visible && { offScreen: true as const }),
        state: control.state(),
        ...(control.choices !== undefined && { choices }),
        ...(matching.length > choices.length && { moreChoices: matching.length - choices.length }),
        actions: Object.fromEntries(Object.entries(control.actions()).map(([action, spec]) => [action, spec.takes])),
    };
};

const matchesText = (located: Located, text: string): boolean =>
    folded(located.name).includes(text) ||
    folded(String(located.control.state()[`chosen`] ?? ``)).includes(text) ||
    (located.control.choices?.() ?? []).some((choice) => folded(choice.label).includes(text));

/** What a page tool is called with: the agent's JSON, unparsed. */
type ToolInput = Parameters<WebMcpTool[`execute`]>[0];

// A tool's input, or the sentence that says what is wrong with it: zod's own message is its issues as JSON.
const parsed = <Schema extends z.ZodType>(schema: Schema, input: ToolInput | StepValue): z.output<Schema> => {
    const result = schema.safeParse(input);
    if (!result.success) {
        throw new Error(z.prettifyError(result.error));
    }
    return result.data;
};

const ReadInput = z.object({
    text: z.string().optional(),
    kind: z.string().optional(),
    offScreen: z.boolean().optional(),
});

/** What `editor_controls` answers: the controls on screen (or all of them), optionally only those `text` finds. */
export const readControls = (registry: ReadonlyMap<string, AgentControl>, input: ToolInput): { controls: ControlRead[]; more?: number } => {
    const { text, kind, offScreen = false } = parsed(ReadInput, input);
    const wanted = text === undefined || spaced(text) === `` ? undefined : folded(text);
    const found = locate(registry).filter(
        (located) =>
            (offScreen || located.visible) && (kind === undefined || located.control.kind === kind) && (wanted === undefined || matchesText(located, wanted)),
    );
    const controls = found.slice(0, CONTROL_LIMIT).map((located) => readOf(located, wanted));
    return found.length > controls.length ? { controls, more: found.length - controls.length } : { controls };
};

// A control named in a step: its ref, else its name. A name is matched whole first, then as whole words within a
// longer name, among the controls on screen; off screen only when nothing on screen answers to it.
const resolve = (registry: ReadonlyMap<string, AgentControl>, asked: string): Located => {
    const everything = locate(registry);
    const byRef = everything.find((located) => located.ref === asked);
    if (byRef !== undefined) {
        return byRef;
    }
    const wanted = folded(asked);
    const words = new RegExp(`(^|[^\\p{L}\\p{N}])${wanted.replace(/[.*+?^${}()|[\]\\]/gu, `\\$&`)}($|[^\\p{L}\\p{N}])`, `u`);
    for (const pool of [everything.filter((located) => located.visible), everything.filter((located) => !located.visible)]) {
        const whole = pool.filter((located) => folded(located.name) === wanted);
        const found = whole.length > 0 ? whole : pool.filter((located) => words.test(folded(located.name)));
        const [only, second] = found;
        if (only !== undefined && second === undefined) {
            return only;
        }
        if (second !== undefined) {
            throw new Error(`"${asked}" names ${found.length} controls: ${found.map((located) => `${located.ref} (${located.control.kind} "${located.name}")`).join(`, `)}; pass a ref`);
        }
    }
    const named = everything.filter((located) => located.visible && located.name !== ``).map((located) => `"${located.name}"`);
    throw new Error(`no control is named "${asked}"${named.length > 0 ? `; on screen: ${named.slice(0, 12).join(`, `)}` : ``}`);
};

// A choice by its value, else by its words; words two choices share are refused rather than guessed between.
const choiceNamed = (choices: readonly ControlChoice[], asked: string): ControlChoice => {
    const byValue = choices.find((choice) => choice.value === asked);
    const byWords = choices.filter((choice) => folded(choice.label) === folded(asked));
    const [first, second] = byWords;
    const found = byValue ?? (second === undefined ? first : undefined);
    if (found === undefined) {
        const offered = (second === undefined ? choices : byWords).map((choice) => `"${choice.value}"`);
        throw new Error(
            second === undefined
                ? `no choice "${asked}"; the choices are ${offered.slice(0, CHOICE_LIMIT).join(`, `)}`
                : `"${asked}" is the words of several choices; pass one of the values ${offered.join(`, `)}`,
        );
    }
    if (found.disabled === true) {
        throw new Error(`"${found.label}" can't be chosen here`);
    }
    return found;
};

const Step = z.object({
    control: z.string().min(1),
    action: z.string().min(1),
    value: z.union([z.string(), z.boolean()]).optional(),
});
const ActInput = z.object({ steps: z.array(Step).min(1) });
type StepValue = z.infer<typeof Step>[`value`];

// A step's value, read as what its action takes.
const FlagValue = z.boolean({ error: `this action takes value: true or false` });
const ChoiceValue = z.string({ error: `this action takes value: a choice's value or its words` });

// Runs one step; answers the value a choice asked for, which the control should come to hold.
const run = (located: Located, action: ControlAction, value: StepValue): string | undefined => {
    switch (action.takes) {
        case `nothing`:
            action.run();
            return undefined;
        case `flag`:
            action.run(parsed(FlagValue, value));
            return undefined;
        case `choice`: {
            const choice = choiceNamed(located.control.choices?.() ?? [], parsed(ChoiceValue, value));
            action.run(choice);
            return choice.value;
        }
    }
};

// A setting that loads before it applies (a language fetches its words) holds the old value for a moment after the
// press. Waited for, within reason, so the answer says where the control ended up rather than where it started.
const LAND_WAIT_MS = 1_000;
const LAND_POLL_MS = 50;

const landed = async (registry: ReadonlyMap<string, AgentControl>, ref: string, expected: string): Promise<boolean> => {
    const deadline = Date.now() + LAND_WAIT_MS;
    for (;;) {
        await nextTick();
        const value = registry.get(ref)?.state()[`value`];
        if (value === expected || value === undefined || Date.now() >= deadline) {
            return value === expected || value === undefined;
        }
        await sleep(LAND_POLL_MS);
    }
};

/**
 * One step's outcome: the control it worked, and what that control holds afterwards (gone, when the step closed it).
 * `landed: false` is a choice the control still didn't hold a second later: the app refused it or is slow to apply it.
 */
interface StepDone {
    readonly control: string;
    readonly action: string;
    readonly now: Readonly<Record<string, ControlStateValue>> | `gone`;
    readonly landed?: false;
}

/** What `editor_act` answers: each step done in order, and the first that could not be, with why. Earlier ones stay done. */
export const actOnControls = async (
    registry: ReadonlyMap<string, AgentControl>,
    input: ToolInput,
): Promise<{ ok: boolean; steps: StepDone[]; failed?: { step: number; error: string } }> => {
    const { steps } = parsed(ActInput, input);
    const done: StepDone[] = [];
    for (const [index, step] of steps.entries()) {
        try {
            const located = resolve(registry, step.control);
            const actions = located.control.actions();
            const action = actions[step.action];
            if (action === undefined) {
                const offered = Object.keys(actions);
                throw new Error(`${located.control.kind} "${located.name}" takes no ${step.action} now; it takes ${offered.length > 0 ? offered.join(`, `) : `nothing`}`);
            }
            const expected = run(located, action, step.value);
            // The change renders before the next step looks: a dialog a step opened is there for the step after.
            let arrived = true;
            if (expected === undefined) {
                await nextTick();
            } else {
                arrived = await landed(registry, located.ref, expected);
            }
            const still = registry.get(located.ref);
            done.push({ control: located.ref, action: step.action, now: still === undefined ? `gone` : still.state(), ...(!arrived && { landed: false as const }) });
        } catch (error) {
            return { ok: false, steps: done, failed: { step: index, error: errorMessage(error) } };
        }
    }
    return { ok: true, steps: done };
};

// A view draws its sections as their chunks and data arrive, after the router calls the navigation done: a call made
// straight after navigating read an empty page. So the controls on screen are counted until two counts agree.
const STEADY_POLL_MS = 150;
const STEADY_CAP_MS = 2_000;

const steady = async (registry: ReadonlyMap<string, AgentControl>): Promise<void> => {
    const deadline = Date.now() + STEADY_CAP_MS;
    const count = (): number => locate(registry).filter((located) => located.visible).length;
    let before = count();
    while (Date.now() < deadline) {
        await sleep(STEADY_POLL_MS);
        const now = count();
        if (now === before && now > 0) {
            return;
        }
        before = now;
    }
};

/**
 * The two tools, over the record the dev build armed before the app mounted (main.ts). `settled` resolves once the
 * router has finished the navigation under way; the controls are then given time to finish drawing.
 */
export const controlTools = (settled: () => Promise<void>): WebMcpTool[] => {
    const registry = armAgentControls();
    const ready = async (): Promise<void> => {
        await settled();
        await steady(registry);
    };
    return [
        {
            name: `editor_controls`,
            description:
                `The design kit's controls on screen now (pickers, segmented strips and tabs, open dialogs, expandable rows), ` +
                `each with a ref, its name, what it holds, its choices and the actions editor_act can run on it. Cheaper than a ` +
                `snapshot for finding a setting: text keeps the controls whose name, current choice or choices contain it ` +
                `(case and accents ignored); kind keeps one kind; offScreen adds those mounted but not shown (a hidden tab). ` +
                `Plain buttons, links and text fields are not here: use the page snapshot for those.`,
            inputSchema: {
                type: `object`,
                properties: {
                    text: { type: `string` },
                    kind: { type: `string`, enum: [`picker`, `segmented`, `dialog`, `disclosure`] },
                    offScreen: { type: `boolean` },
                },
            },
            annotations: { readOnlyHint: true },
            execute: async (input) => {
                await ready();
                return readControls(registry, input);
            },
        },
        {
            name: `editor_act`,
            description:
                `Run steps on the controls editor_controls lists, in order, each through the control's own model as a press ` +
                `would (the app's watchers and saves run as they do for a person). control is a ref or the control's name; ` +
                `value is a choice's value or words for a choice action, true or false for a flag. Stops at the first step ` +
                `that fails and says why; the steps before it stay done. Answers what each control holds afterwards.`,
            inputSchema: {
                type: `object`,
                properties: {
                    steps: {
                        type: `array`,
                        items: {
                            type: `object`,
                            properties: {
                                control: { type: `string`, description: `A ref (c12) or the control's name` },
                                action: { type: `string`, description: `An action the control lists: pick, select, setOpen, close, confirm, cancel` },
                                value: { type: [`string`, `boolean`] },
                            },
                            required: [`control`, `action`],
                        },
                    },
                },
                required: [`steps`],
            },
            execute: async (input) => {
                await ready();
                return actOnControls(registry, input);
            },
        },
    ];
};
