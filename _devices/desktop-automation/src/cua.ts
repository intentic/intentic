import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseChord } from "./keys.js";
import { looksLikeUrl } from "./parse.js";
import { environment } from "./run.js";
import {
    type Desktop,
    DesktopError,
    type DisplayInfo,
    type ElementAction,
    type ElementTree,
    type MouseButton,
    type Point,
    type Rect,
    type ScreenFrame,
    type ScrollDirection,
    type UiElement,
    type WindowInfo,
} from "./types.js";

/* cua-driver (github.com/trycua/cua), driven over its own MCP server on stdio, as a Desktop. It is what macOS gets at
   all (this package has no native input there), and what gives Linux an accessibility tree: the driver walks AX on
   macOS, UI Automation on Windows and AT-SPI on Linux, behind one tool surface. An external program the owner
   installs, never a module loaded into this process: the single-file binary stays free of native code.

   Everything here acts on the primary display, in the pixels of `get_desktop_state`'s screenshot (the driver maps
   them to its platform's own space, Retina points included). Elements are the driver's per-snapshot tokens: a token
   is stale once the same window is read again, so a listing is kept here and pointed at until the next one. Measured
   against cua-driver 0.33.4 on Linux/X11 (2026-10-05). */

const CALL_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 10_000;
const PROTOCOL_VERSION = "2025-06-18";
const INSTALL = "Install cua-driver (https://cua.ai/driver): curl -fsSL https://cua.ai/driver/install.sh | bash, or install.ps1 on Windows";
const DESKTOP_TARGET = { kind: "desktop", display_id: "primary" } as const;

// Where the driver's own installers put it, after an explicit path and PATH: `install.sh` writes ~/.local/bin, and
// `install.ps1` writes %LOCALAPPDATA%\Programs\Cua\cua-driver\bin.
export const cuaDriverCandidates = (env: NodeJS.ProcessEnv = environment(), home: string = homedir()): string[] => [
    ...(env["INTENTIC_CUA_DRIVER"] === undefined || env["INTENTIC_CUA_DRIVER"] === "" ? [] : [env["INTENTIC_CUA_DRIVER"]]),
    ...(env["PATH"] ?? "")
        .split(process.platform === "win32" ? ";" : ":")
        .filter((dir) => dir !== "")
        .map((dir) => join(dir, process.platform === "win32" ? "cua-driver.exe" : "cua-driver")),
    join(home, ".local", "bin", "cua-driver"),
    ...(env["LOCALAPPDATA"] === undefined ? [] : [join(env["LOCALAPPDATA"], "Programs", "Cua", "cua-driver", "bin", "cua-driver.exe")]),
];

export const findCuaDriver = (env: NodeJS.ProcessEnv = environment()): string | undefined => cuaDriverCandidates(env).find((path) => existsSync(path));

// One MCP tool result. `structuredContent` is read by whichever tool asked, against that tool's own schema below.
const ToolResultSchema = z.object({
    content: z
        .array(z.object({ type: z.string().catch(""), text: z.string().optional().catch(undefined), data: z.string().optional().catch(undefined) }))
        .catch([]),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().catch(false),
});

type ToolResult = z.infer<typeof ToolResultSchema>;

// One line the driver wrote: an answer to a request (by id), or something this client does not wait on.
const AnswerSchema = z.object({
    id: z.number(),
    result: z.unknown().optional(),
    error: z.object({ message: z.string().catch("no reason given") }).optional().catch(undefined),
});

type Answer = z.infer<typeof AnswerSchema>;

interface Pending {
    readonly resolve: (message: Answer) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
}

/* One driver process and one MCP session on it, started on the first call and started again after it exits. Requests
   are newline-delimited JSON-RPC, as MCP's stdio transport is. */
export class CuaClient {
    readonly #binary: string;
    readonly #env: NodeJS.ProcessEnv;
    readonly #session = `intentic-${randomUUID()}`;
    #child: ChildProcess | undefined;
    #ready: Promise<void> | undefined;
    #buffer = "";
    #next = 0;
    readonly #pending = new Map<number, Pending>();

    constructor(binary: string, env: NodeJS.ProcessEnv = environment()) {
        this.#binary = binary;
        // The driver's own telemetry and self-update checks stay off: this process is not its user.
        this.#env = { ...env, CUA_DRIVER_RS_TELEMETRY_ENABLED: "false", CUA_DRIVER_RS_UPDATE_CHECK: "false" };
    }

    #fail(error: Error): void {
        for (const [, pending] of this.#pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.#pending.clear();
        this.#child = undefined;
        this.#ready = undefined;
    }

    #read(chunk: Buffer): void {
        this.#buffer += chunk.toString("utf8");
        for (let end = this.#buffer.indexOf("\n"); end >= 0; end = this.#buffer.indexOf("\n")) {
            const line = this.#buffer.slice(0, end).trim();
            this.#buffer = this.#buffer.slice(end + 1);
            if (line === "") {
                continue;
            }
            const message = answerIn(line);
            const pending = message === undefined ? undefined : this.#pending.get(message.id);
            if (message !== undefined && pending !== undefined) {
                clearTimeout(pending.timer);
                this.#pending.delete(message.id);
                pending.resolve(message);
            }
        }
    }

    #request(method: string, params: RequestParams, timeoutMs: number): Promise<Answer> {
        const child = this.#child;
        if (child?.stdin === null || child?.stdin === undefined) {
            return Promise.reject(new DesktopError("cua-driver is not running."));
        }
        this.#next += 1;
        const id = this.#next;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new DesktopError(`cua-driver did not answer ${method} within ${timeoutMs / 1_000}s.`));
            }, timeoutMs);
            this.#pending.set(id, { resolve, reject, timer });
            child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
    }

    #start(): Promise<void> {
        const child = spawn(this.#binary, ["mcp"], { env: this.#env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
        this.#child = child;
        child.stdout?.on("data", (chunk: Buffer) => this.#read(chunk));
        child.on("error", (error: NodeJS.ErrnoException) =>
            this.#fail(new DesktopError(error.code === "ENOENT" ? `There is no cua-driver at ${this.#binary}.` : `cua-driver failed: ${error.message}`, INSTALL)),
        );
        child.on("exit", (code) => this.#fail(new DesktopError(`cua-driver exited (${code ?? "signal"}).`)));
        return (async () => {
            await this.#request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "intentic", version: "1" } }, START_TIMEOUT_MS);
            child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
            await this.#call("start_session", {}, START_TIMEOUT_MS);
        })();
    }

    async #call(name: string, args: ToolArgs, timeoutMs: number): Promise<ToolResult> {
        const answer = await this.#request("tools/call", { name, arguments: { ...args, session: this.#session } }, timeoutMs);
        if (answer.error !== undefined) {
            throw new DesktopError(`cua-driver refused ${name}: ${answer.error.message}`);
        }
        const result = ToolResultSchema.safeParse(answer.result ?? {});
        if (!result.success) {
            throw new DesktopError(`cua-driver answered ${name} with something that is not a tool result.`);
        }
        return result.data;
    }

    // One tool call; a result the driver marks as an error is thrown in its own words.
    async call(name: string, args: ToolArgs = {}, timeoutMs: number = CALL_TIMEOUT_MS): Promise<ToolResult> {
        this.#ready ??= this.#start().catch((error) => {
            this.#child?.kill();
            this.#fail(error instanceof Error ? error : new Error(String(error)));
            throw error;
        });
        await this.#ready;
        const result = await this.#call(name, args, timeoutMs);
        if (result.isError) {
            throw new DesktopError(`cua-driver ${name}: ${textOf(result) || "failed"}`);
        }
        return result;
    }

    stop(): void {
        this.#child?.kill();
        this.#fail(new DesktopError("cua-driver was stopped."));
    }
}

// A JSON value the driver may send as a tool argument or a request's params.
type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json | undefined };
type ToolArgs = { readonly [key: string]: Json | undefined };
type RequestParams = { readonly [key: string]: Json | undefined };

// A line of the driver's output as an answer this client waits on, or undefined for anything else (a notification,
// a log line on the wrong stream, a partial write).
const answerIn = (line: string): Answer | undefined => {
    try {
        const parsed = AnswerSchema.safeParse(JSON.parse(line));
        return parsed.success ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): a line that is not JSON is not an answer, which is all this needs to know.
        return undefined;
    }
};

const textOf = (result: ToolResult): string =>
    result.content
        .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
        .join("\n")
        .trim();

const imageOf = (result: ToolResult): Buffer => {
    const image = result.content.find((part) => part.type === "image" && part.data !== undefined);
    if (image?.data === undefined) {
        throw new DesktopError("cua-driver answered the screenshot without an image.");
    }
    return Buffer.from(image.data, "base64");
};

// A coordinate or size the driver reported; anything else reads as zero, a place nobody can point at.
const length = z.number().refine(Number.isFinite).catch(0);

// What one tool's structuredContent holds, read with the schema for that tool; a shape the driver changed reads as
// its empty form rather than as a crash.
const structured = <Schema extends z.ZodType>(result: ToolResult, schema: Schema): z.output<Schema> => schema.parse(result.structuredContent ?? {});

// X11 keysym names, this package's vocabulary (keys.ts), as the driver spells them.
const CUA_KEYS = new Map([
    ["Return", "return"],
    ["Escape", "escape"],
    ["BackSpace", "backspace"],
    ["Delete", "delete"],
    ["Insert", "insert"],
    ["Tab", "tab"],
    ["space", "space"],
    ["Up", "up"],
    ["Down", "down"],
    ["Left", "left"],
    ["Right", "right"],
    ["Home", "home"],
    ["End", "end"],
    ["Page_Up", "pageup"],
    ["Page_Down", "pagedown"],
]);

export const cuaKey = (combo: string) => {
    const chord = parseChord(combo);
    const key = CUA_KEYS.get(chord.key) ?? (/^F\d{1,2}$/i.test(chord.key) ? chord.key.toLowerCase() : chord.key);
    return { key, modifiers: [...chord.modifiers] };
};

// A window id here is the driver's pid and window id together: every window tool asks for both.
const windowKey = (pid: number, windowId: number): string => `${pid}:${windowId}`;

const windowArgs = (id: string) => {
    const [pid, windowId] = id.split(":").map(Number);
    if (pid === undefined || windowId === undefined || !Number.isInteger(pid) || !Number.isInteger(windowId)) {
        throw new DesktopError(`"${id}" is not a window id from this device's window list.`);
    }
    return { pid, window_id: windowId };
};

const WindowRowSchema = z.object({
    pid: z.number(),
    window_id: z.number(),
    title: z.string().catch(""),
    app_name: z.string().catch("unknown"),
    is_on_screen: z.boolean().catch(true),
    z_index: z.number().optional().catch(undefined),
    bounds: z.object({ x: length, y: length, width: length, height: length }).catch({ x: 0, y: 0, width: 0, height: 0 }),
});

const WindowsSchema = z.object({ windows: z.array(z.unknown()).catch([]) }).catch({ windows: [] });

// list_windows, and get_desktop_state's own window list: frontmost first.
export const parseCuaWindows = (result: ToolResult): WindowInfo[] =>
    structured(result, WindowsSchema).windows.flatMap((raw) => {
        const row = WindowRowSchema.safeParse(raw);
        if (!row.success || !row.data.is_on_screen) {
            return [];
        }
        const { pid, window_id: windowId, title, app_name: app, bounds, z_index: stacking } = row.data;
        // The driver lists frontmost first (z_index 0), which is the best reading of focus it gives.
        return [{ id: windowKey(pid, windowId), title, app, bounds, focused: stacking === 0 }];
    });

// Roles that take text, which set_value writes; AT-SPI, AX and UIA spell them differently.
const SETTABLE = /^(text|entry|edit|password text|spin button|combo box|AXTextField|AXTextArea|AXComboBox|search field|terminal)$/i;

const FrameSchema = z.object({ x: length, y: length, w: length, h: length });

const ElementRowSchema = z.object({
    element_token: z.string().min(1),
    role: z.string().catch(""),
    label: z.string().catch(""),
    value: z.string().optional().catch(undefined),
    actions: z.array(z.string()).catch([]),
    enabled: z.boolean().catch(true),
    focused: z.boolean().catch(false),
    depth: length,
    frame: FrameSchema.optional().catch(undefined),
    screenshot_frame: FrameSchema.optional().catch(undefined),
});

type ElementRow = z.infer<typeof ElementRowSchema>;

const ElementsSchema = z.object({ elements: z.array(z.unknown()).catch([]), elements_complete: z.boolean().catch(true) }).catch({ elements: [], elements_complete: true });

// Where an element is on the desktop, or nowhere known. The driver's `frame` is already in desktop pixels (its
// `screenshot_frame` is the window-local one), so it is taken as it is, with one exception: GTK 4 reports every child
// at its toplevel's own origin, so a child there is a position nobody knows rather than a corner to click. Measured on
// zenity 4.1 under cua-driver 0.33.4 (2026-10-05): both of a dialog's buttons at the dialog's (485, 285).
const placeOf = (row: ElementRow, window: Rect): Rect => {
    const unknown = { x: 0, y: 0, width: 0, height: 0 };
    const placed =
        row.frame !== undefined
            ? { x: row.frame.x, y: row.frame.y, width: row.frame.w, height: row.frame.h }
            : row.screenshot_frame !== undefined
              ? { x: window.x + row.screenshot_frame.x, y: window.y + row.screenshot_frame.y, width: row.screenshot_frame.w, height: row.screenshot_frame.h }
              : unknown;
    const atWindowOrigin = placed.x === window.x && placed.y === window.y && (placed.width !== window.width || placed.height !== window.height);
    return row.depth > 0 && atWindowOrigin ? unknown : placed;
};

// What an element offers, read off the accessibility actions the driver names and its role.
const actionsOf = (row: ElementRow): ElementAction[] => {
    const names = row.actions.map((name) => name.toLowerCase());
    return [
        ...(names.some((name) => /click|press|activate|jump|invoke|open/.test(name)) ? (["invoke"] as const) : []),
        ...(SETTABLE.test(row.role) ? (["set_value"] as const) : []),
        ...(names.some((name) => name.includes("toggle")) ? (["toggle"] as const) : []),
        ...(names.some((name) => name.includes("expand")) ? (["expand", "collapse"] as const) : []),
    ];
};

// One get_window_state snapshot, as this package's UiElements; a row without a token could not be addressed again.
export const parseCuaElements = (result: ToolResult, window: Rect) => {
    const snapshot = structured(result, ElementsSchema);
    const elements = snapshot.elements.flatMap((raw) => {
        const row = ElementRowSchema.safeParse(raw);
        if (!row.success) {
            return [];
        }
        const { element_token: id, role, label, value, enabled, focused, depth } = row.data;
        return [{ id, role: role.toLowerCase(), name: label, value, bounds: placeOf(row.data, window), enabled, focused, actions: actionsOf(row.data), depth }];
    });
    return { elements, complete: snapshot.elements_complete };
};

const ScreenSizeSchema = z.object({ width: length, height: length, scale_factor: z.number().positive().catch(1) });

const ClipboardSchema = z.object({ text: z.string().catch("") }).catch({ text: "" });

// The cua-driver half of a Desktop: everything an agent needs, through the driver alone.
export const cuaDesktop = (client: CuaClient): Desktop => {
    // The latest snapshot per window: its tokens are the only live ones, so pointing at an element reads it here.
    const snapshots = new Map<string, UiElement[]>();
    const screenSize = async (): Promise<ScreenFrame> => {
        const size = structured(await client.call("get_screen_size"), ScreenSizeSchema);
        return { width: Math.round(size.width * size.scale_factor), height: Math.round(size.height * size.scale_factor), origin: { x: 0, y: 0 } };
    };
    const windows = async (): Promise<WindowInfo[]> => parseCuaWindows(await client.call("list_windows", { on_screen_only: true }));
    const at = (point: Point) => ({ x: Math.round(point.x), y: Math.round(point.y) });
    const press = async (combo: string): Promise<void> => {
        const { key, modifiers } = cuaKey(combo);
        await client.call("press_key", { key, modifiers, target: DESKTOP_TARGET });
    };
    const elementsOf = async (window: string): Promise<ElementTree> => {
        const listed = (await windows()).find((candidate) => candidate.id === window);
        if (listed === undefined) {
            throw new DesktopError(`There is no window ${window} on this device now. List the windows again.`);
        }
        const state = await client.call("get_window_state", { ...windowArgs(window), include_screenshot: false, max_elements: 2_500 });
        const { elements, complete } = parseCuaElements(state, listed.bounds);
        snapshots.set(window, elements);
        return { window: { id: window, title: listed.title, app: listed.app }, elements, truncated: !complete };
    };
    return {
        frame: screenSize,
        // The driver captures the primary display whole; `shoot` cuts a region out of it.
        capture: async () => imageOf(await client.call("get_desktop_state")),
        displays: async (): Promise<DisplayInfo[]> => {
            const { width, height } = await screenSize();
            return [{ name: "primary", primary: true, bounds: { x: 0, y: 0, width, height } }];
        },
        move: async (to) => void (await client.call("move_cursor", { ...at(to), target: DESKTOP_TARGET })),
        click: async (point, button: MouseButton) => void (await client.call("click", { ...at(point), button, target: DESKTOP_TARGET })),
        doubleClick: async (point) => void (await client.call("click", { ...at(point), count: 2, target: DESKTOP_TARGET })),
        drag: async (from, to) =>
            void (await client.call("drag", { from_x: Math.round(from.x), from_y: Math.round(from.y), to_x: Math.round(to.x), to_y: Math.round(to.y), target: DESKTOP_TARGET })),
        type: async (text) => void (await client.call("type_text", { text, target: DESKTOP_TARGET })),
        key: press,
        scroll: async (point, direction: ScrollDirection, amount) =>
            void (await client.call("scroll", { ...at(point), direction, by: "line", amount: Math.max(1, Math.round(amount)), target: DESKTOP_TARGET })),
        windows,
        focusWindow: async (id) => void (await client.call("bring_to_front", windowArgs(id))),
        launch: async (target) =>
            void (await client.call(
                "launch_app",
                looksLikeUrl(target) ? { urls: [target] } : existsSync(target) ? { launch_path: target } : { name: target },
            )),
        readClipboard: async () => structured(await client.call("clipboard_read", { include_text: true }), ClipboardSchema).text,
        writeClipboard: async (text) => void (await client.call("clipboard_write", { text })),
        elements: async (window) => {
            const target = window ?? (await windows()).find((candidate) => candidate.focused)?.id;
            if (target === undefined) {
                throw new DesktopError("No window has the keyboard; name one from the window list.");
            }
            return await elementsOf(target);
        },
        element: async (window, id) => snapshots.get(window)?.find((element) => element.id === id),
        elementAct: async (window, id, action: ElementAction, value) => {
            const { pid } = windowArgs(window);
            if (action === "set_value") {
                await client.call("set_value", { pid, element_token: id, value: value ?? "" });
                return;
            }
            // The driver's own click on a token fires the element's accessibility action where it has one, which is
            // what invoke, toggle, select and expand all mean on an element that offers them.
            await client.call("click", { pid, element_token: id });
        },
    };
};

// The driver's accessibility half alone, for a platform whose own backend has no element reader (Linux).
export const cuaElementsOnly = (client: CuaClient): Pick<Desktop, "elements" | "element" | "elementAct"> => {
    const whole = cuaDesktop(client);
    return { elements: whole.elements, element: whole.element, elementAct: whole.elementAct };
};
