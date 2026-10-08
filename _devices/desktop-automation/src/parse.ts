import { z } from "zod";
import {
    type DisplayInfo,
    DesktopError,
    type ElementAction,
    type ElementTree,
    type Rect,
    type SessionState,
    type UiElement,
    type WindowInfo,
} from "./types.js";

// Turns platform window-lister output (wmctrl/PowerShell text or JSON) into WindowInfo, and writes the one
// sentence that gets built from such a read rather than from a list. Pure functions, testable without a desktop.

// wmctrl -lGpx columns: nine fields, then the title is everything remaining on the line. `app` is the part of
// `instance.Class` after the dot.
export const parseWmctrl = (output: string, focusedId?: string): WindowInfo[] =>
    output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .flatMap((line) => {
            // One regex instead of split-and-rejoin: padded columns cannot be rejoined and titles often contain spaces.
            const fields = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
            if (fields === null) {
                return [];
            }
            const [, id, , , x, y, width, height, wmClass, , rawTitle] = fields;
            if (id === undefined || wmClass === undefined) {
                return [];
            }
            const title = (rawTitle ?? "").trim();
            const app = wmClass.includes(".") ? (wmClass.split(".").pop() ?? wmClass) : wmClass;
            return [
                {
                    id,
                    title,
                    app,
                    bounds: { x: Number(x), y: Number(y), width: Number(width), height: Number(height) },
                    // wmctrl ids are hex, xdotool ids are decimal; compared as numbers so both spellings match.
                    focused: focusedId !== undefined && Number(id) === Number(focusedId),
                },
            ];
        });

interface SwayNode {
    readonly id?: number;
    readonly name?: string | null;
    readonly app_id?: string | null;
    readonly window_properties?: { readonly class?: string };
    readonly rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly focused?: boolean;
    readonly nodes?: readonly SwayNode[];
    readonly floating_nodes?: readonly SwayNode[];
}

// get_tree is a nested tree; a window is a leaf with a name and geometry, everything above is scaffolding. Recurses
// since depth varies and floating windows are a separate child list.
const walkSwayNode = (node: SwayNode): WindowInfo[] => {
    const children = [...(node.nodes ?? []), ...(node.floating_nodes ?? [])];
    const descendants = children.flatMap(walkSwayNode);
    const name = node.name ?? "";
    const app = node.app_id ?? node.window_properties?.class ?? "";
    // A container with children is a split, not a window, regardless of its name.
    if (children.length > 0 || name === "" || node.rect === undefined || node.id === undefined) {
        return descendants;
    }
    return [
        {
            id: String(node.id),
            title: name,
            app: app === "" ? "unknown" : app,
            bounds: { x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height },
            focused: node.focused === true,
        },
        ...descendants,
    ];
};

// A lister that answered something other than its JSON has not said the desktop is empty, so it is not read as that.
const listedJson = (json: string, lister: string): unknown => {
    try {
        return JSON.parse(json);
    } catch {
        const said = json.trim().slice(0, 200);
        throw new DesktopError(`${lister} answered something that is not a window list: ${said === "" ? "nothing" : said}`);
    }
};

export const parseSwayTree = (json: string): WindowInfo[] => walkSwayNode(listedJson(json, "swaymsg") as SwayNode);

// ConvertTo-Json emits a bare object for one item, an array otherwise; both shapes are accepted here instead of
// relying on -AsArray (PowerShell 7 only).
export const parseWindowsJson = (json: string): WindowInfo[] => {
    const parsed = listedJson(json, "PowerShell");
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((row) => {
        const record = row as Record<string, unknown>;
        const id = record["id"];
        if (typeof id !== "string" || id === "" || id === "0") {
            return [];
        }
        return [
            {
                id,
                title: String(record["title"] ?? ""),
                app: String(record["app"] ?? "unknown"),
                bounds: {
                    x: Number(record["x"] ?? 0),
                    y: Number(record["y"] ?? 0),
                    width: Number(record["width"] ?? 0),
                    height: Number(record["height"] ?? 0),
                },
                focused: record["focused"] === true,
                ...(typeof record["pid"] === "number" && record["pid"] > 0 ? { pid: record["pid"] } : {}),
            },
        ];
    });
};

// Undefined rather than a hopeful default when the output is not the shape asked for: "nothing holds the
// foreground" is an observation about the desktop, and a read that failed has not made one. A caller that
// cannot tell the two apart reports an unreadable machine as an idle one.
export const parseSessionJson = (json: string): SessionState | undefined => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return undefined;
    }
    const record = parsed as Record<string, unknown> | null;
    if (record === null || typeof record !== "object" || typeof record["locked"] !== "boolean") {
        return undefined;
    }
    const id = String(record["id"] ?? "");
    // A zero handle is GetForegroundWindow's own "nobody", not a window to go looking for.
    const foreground = id === "" || id === "0" ? undefined : { id, title: String(record["title"] ?? ""), app: String(record["app"] ?? "unknown") };
    return { locked: record["locked"], foreground };
};

const heldBy = (foreground: NonNullable<SessionState["foreground"]>): string =>
    foreground.title === "" ? `an untitled window [${foreground.app}]` : `"${foreground.title}" [${foreground.app}]`;

// What to say when focus was refused. The old wording listed every cause it might have been ("a UAC prompt, a
// full-screen app, or a locked session") on every refusal, which reads as a diagnosis and is a guess — and it
// sent a release investigation looking at the app for a machine whose session was locked. Each branch here is
// something the machine was asked; `undefined` is the only one that admits to not knowing.
export const focusRefusal = (id: string, attempts: number, state: SessionState | undefined): string => {
    const cause =
        state === undefined
            ? `nothing here could read which window has it`
            : state.locked
              ? `Windows is drawing its sign-in screen over this session (LogonUI is running), so the keyboard is on a desktop no ordinary process can reach — somebody has to sign in on that machine`
              : state.foreground === undefined
                ? `nothing holds the foreground: the window is gone, or it belongs to another desktop`
                : `${heldBy(state.foreground)} holds it and would not let go (a UAC prompt, a full-screen app, or a lock screen still up)`;
    return `Windows would not give window ${id} the keyboard after ${attempts} attempts: ${cause}.`;
};

// Whether a launch target should be opened (a URL, or an existing path) rather than run as a command; picks between
// xdg-open/Start-Process and spawning it directly.
export const looksLikeUrl = (target: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^(www\.|mailto:)/i.test(target);

// A number the lister actually measured; anything else is not a coordinate.
const measured = z.number().refine(Number.isFinite);

// What a lister answered, read as `schema`, or the sentence saying it answered something else: a lister that printed
// an error has not said the desktop is empty.
const jsonFrom = <Schema extends z.ZodType>(json: string, schema: Schema, lister: string, what: string): z.output<Schema> => {
    const said = json.trim().slice(0, 200);
    const refuse = (): never => {
        throw new DesktopError(`${lister} answered something that is not ${what}: ${said === "" ? "nothing" : said}`);
    };
    let parsed: z.ZodSafeParseResult<z.output<Schema>>;
    try {
        parsed = schema.safeParse(JSON.parse(json));
    } catch {
        return refuse();
    }
    return parsed.success ? parsed.data : refuse();
};

// Each row that reads as `row`; the rest are dropped rather than guessed at.
const rowsOf = <Row extends z.ZodType>(row: Row) =>
    z.array(z.unknown()).transform((rows) =>
        rows.flatMap((candidate) => {
            const parsed = row.safeParse(candidate);
            return parsed.success ? [parsed.data] : [];
        }),
    );

// ConvertTo-Json writes one item as a bare object and several as an array; both are a list here.
const psListOf = <Row extends z.ZodType>(row: Row) =>
    z.union([z.array(z.unknown()), z.unknown().transform((one) => [one])]).pipe(rowsOf(row));

const DisplayRowSchema = z.object({
    name: z.string().catch(""),
    primary: z.boolean().catch(false),
    x: measured,
    y: measured,
    width: measured.refine((width) => width > 0),
    height: measured.refine((height) => height > 0),
});

// Screen.AllScreens as screen.ts's script writes it; a row missing its geometry is dropped rather than guessed.
export const parseDisplaysJson = (json: string): DisplayInfo[] =>
    jsonFrom(json, psListOf(DisplayRowSchema), "PowerShell", "a display list").map((row) => ({
        name: row.name,
        primary: row.primary,
        bounds: { x: row.x, y: row.y, width: row.width, height: row.height },
    }));

// `xrandr --listactivemonitors`: " 0: +*DP-1 2560/597x1440/336+0+0  DP-1", the star marking the primary.
export const parseXrandrMonitors = (output: string): DisplayInfo[] =>
    output.split(/\r?\n/).flatMap((line) => {
        const fields = /^\s*\d+:\s+\+?(\*)?(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)/.exec(line);
        if (fields === null) {
            return [];
        }
        const [, star, name, width, height, x, y] = fields;
        return [{ name: name ?? "", primary: star === "*", bounds: { x: Number(x), y: Number(y), width: Number(width), height: Number(height) } }];
    });

const SwayOutputSchema = z.object({
    name: z.string().catch(""),
    active: z.boolean().catch(true),
    rect: z.object({ x: measured, y: measured, width: measured, height: measured }).optional().catch(undefined),
});

// `swaymsg -t get_outputs`. Sway has no primary output; the one at the layout's origin is taken as it.
export const parseSwayOutputs = (json: string): DisplayInfo[] =>
    jsonFrom(json, rowsOf(SwayOutputSchema), "swaymsg", "an output list").flatMap(({ name, active, rect }) =>
        !active || rect === undefined ? [] : [{ name, primary: rect.x === 0 && rect.y === 0, bounds: { ...rect } }],
    );

// "ControlType.CheckBox" to "check box": the programmatic name rather than the localized one, which on a Polish
// Windows reads "pole wyboru" and would make one machine's roles another's mystery.
export const roleOf = (programmatic: string): string =>
    programmatic
        .replace(/^ControlType\./, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase();

// One element as elements-windows.ts's helper writes it: its flags say which patterns the element offers.
const ElementRowSchema = z.object({
    id: z.string().min(1),
    type: z.string().catch(""),
    name: z.string().catch(""),
    value: z.string().optional().catch(undefined),
    x: measured.optional().catch(undefined),
    y: measured.optional().catch(undefined),
    width: measured.optional().catch(undefined),
    height: measured.optional().catch(undefined),
    enabled: z.boolean().catch(true),
    focused: z.boolean().catch(false),
    offscreen: z.boolean().catch(false),
    focusable: z.boolean().catch(false),
    invoke: z.boolean().catch(false),
    settable: z.boolean().catch(false),
    toggle: z.boolean().catch(false),
    expand: z.boolean().catch(false),
    select: z.boolean().catch(false),
    depth: measured.catch(0),
});

type ElementRow = z.infer<typeof ElementRowSchema>;

// The helper's flags, in the order an agent should reach for them.
const actionsOf = (row: ElementRow): ElementAction[] => [
    ...(row.invoke ? (["invoke"] as const) : []),
    ...(row.settable ? (["set_value"] as const) : []),
    ...(row.toggle ? (["toggle"] as const) : []),
    ...(row.select ? (["select"] as const) : []),
    ...(row.expand ? (["expand", "collapse"] as const) : []),
    ...(row.focusable ? (["focus"] as const) : []),
];

// One element. An element the OS gives no rectangle (scrolled away, collapsed) is kept, at zero size: it can still be
// acted on. A row with no id never gets here: nothing could address it again.
const elementOf = (row: ElementRow): UiElement => {
    const shown = !row.offscreen;
    return {
        id: row.id,
        role: roleOf(row.type),
        name: row.name,
        value: row.value,
        bounds: { x: row.x ?? 0, y: row.y ?? 0, width: shown ? (row.width ?? 0) : 0, height: shown ? (row.height ?? 0) : 0 },
        enabled: row.enabled,
        focused: row.focused,
        actions: actionsOf(row),
        depth: row.depth,
    };
};

export const parseElementJson = (json: string): UiElement | undefined => {
    const [row] = jsonFrom(json, psListOf(ElementRowSchema), "UI Automation", "an element");
    return row === undefined ? undefined : elementOf(row);
};

const ElementTreeSchema = z.object({
    window: z.object({ id: z.string().catch(""), title: z.string().catch(""), app: z.string().catch("") }),
    elements: rowsOf(ElementRowSchema).catch([]),
    truncated: z.boolean().catch(false),
});

export const parseElementTreeJson = (json: string): ElementTree => {
    const tree = jsonFrom(json, ElementTreeSchema, "UI Automation", "an element tree");
    return { window: tree.window, elements: tree.elements.map(elementOf), truncated: tree.truncated };
};

// `xwininfo -root -tree`: every window's size and its ABSOLUTE top-left, keyed by its id as a number (wmctrl spells
// ids zero-padded, xwininfo not). The line ends "71x68+1+18  +605+389": size, place in its parent, place on screen.
export const parseXwininfoTree = (output: string): Map<number, Rect> =>
    new Map(
        output.split(/\r?\n/).flatMap((line): [number, Rect][] => {
            const fields = /^\s*(0x[0-9a-f]+)\s.*\s(\d+)x(\d+)[+-]-?\d+[+-]-?\d+\s+\+?(-?\d+)\+?(-?\d+)\s*$/i.exec(line);
            if (fields === null) {
                return [];
            }
            const [, id, width, height, x, y] = fields;
            return [[Number(id), { x: Number(x), y: Number(y), width: Number(width), height: Number(height) }]];
        }),
    );

// wmctrl's geometry under a reparenting window manager counts the frame's offset twice (openbox: 18 px too low, one
// too far right), so a capture of "the window" cut off its top and showed what lay below it. Where xwininfo answers,
// each window takes its exact on-screen rectangle from there instead.
export const withAbsoluteBounds = (windows: readonly WindowInfo[], tree: ReadonlyMap<number, Rect>): WindowInfo[] =>
    windows.map((window) => {
        const exact = tree.get(Number(window.id));
        return exact === undefined ? window : { ...window, bounds: exact };
    });
