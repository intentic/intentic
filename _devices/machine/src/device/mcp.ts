import { errorMessage } from "@intentic/base/errors";
import { browser } from "@intentic/browser";
import {
    describeDisplays,
    describeShot,
    desktop,
    pointingFor,
    regionFor,
    reshoot,
    type ScreenshotTarget,
    shoot,
    type Shot,
} from "@intentic/desktop-automation";
import { type DeviceScopes, SandboxResourcesAskFieldsSchema, SandboxShapeWhenSchema } from "@intentic/sandbox-contract";
import { createMcpServer, type McpAuditEntry, type McpTool, textResult, tool } from "@intentic/sandbox-contract/peer-mcp-server";
import { z } from "zod";
import { audit } from "./audit.js";
import { assertScope, ScopeError } from "./policy.js";
import { describeText } from "./tools/describe.js";
import { editTextFile, listDirectory, readTextFile, trashFile, writeTextFile } from "./tools/files.js";
import { focusWindow, listWindows, openTarget, readClipboard, writeClipboard } from "./tools/apps.js";
import { clickElement, fillElement, listTabs, openPage, pressKey, readPage, selectTab, snapshotPage } from "./tools/browser.js";
import {
    createAndroid,
    DEFAULT_LOG_LINES as DEFAULT_ANDROID_LOG_LINES,
    DEFAULT_SHELL_TIMEOUT_MS as DEFAULT_ANDROID_TIMEOUT_MS,
    machineAndroidDeps,
    MAX_LOG_LINES as MAX_ANDROID_LOG_LINES,
    MAX_SHELL_TIMEOUT_MS as MAX_ANDROID_TIMEOUT_MS,
} from "./tools/android.js";
import { act, describeAction, settle } from "./tools/device.js";
import { actOnElement, listElements } from "./tools/elements.js";
import { elementRefs, frames } from "./tools/view.js";
import {
    DEFAULT_LOG_LINES,
    diagnoseSandbox,
    forgetShape,
    listSandboxes,
    manageSandbox,
    MAX_LOG_LINES,
    removeSandbox,
    SandboxOpSchema,
    SandboxSwapSchema,
    sandboxLogs,
    shapeSandbox,
    swapSandbox,
} from "./tools/sandboxes.js";
import { DEFAULT_TIMEOUT_MS, describeResult, MAX_TIMEOUT_MS, runCommand } from "./tools/shell.js";
import { appLogs, appStatus, appStop, DEFAULT_LOG_LINES as DEFAULT_APP_LOG_LINES, MAX_LOG_LINES as MAX_APP_LOG_LINES, startApp } from "./tools/programs/programs.js";
import { calling } from "./indicator.js";
import { MACHINE_VERSION } from "../version.js";

// The tool surface of a connected device, served by sandbox-contract's peer-mcp-server (dispatch, schema-once
// `tool()`, "a failed tool is not a failed call"). Descriptions here carry the judgement calls the schema
// can't; every tool reads the live grant per call.

const NO_ARGS = z.object({});

// A screenshot as the agent receives it: what it shows and how to read it, then the image. A whole-desktop shot
// also places each display in it, which is how an agent on a wide multi-monitor desk finds the one to look closer at.
const shotContent = async (shot: Shot, what: string): Promise<unknown[]> => {
    frames.sent();
    // allow(silent-catch): the display layout only annotates the shot; a desktop that cannot list it still sends the picture
    const displays = what === "the whole desktop" ? await desktop().displays().catch(() => []) : [];
    const placed = displays.length > 1 ? ` Displays: ${describeDisplays(displays, shot.frame)}.` : "";
    return [
        { type: "text", text: `${describeShot(shot, what)}${placed}` },
        { type: "image", data: shot.png.toString("base64"), mimeType: "image/png" },
    ];
};

const screenshotResult = async (scopes: DeviceScopes, target: ScreenshotTarget): Promise<Record<string, unknown>> => {
    assertScope(scopes, "screen");
    const screen = desktop();
    const { region, what } = await regionFor(screen, frames, target);
    return { content: await shotContent(await shoot(screen, frames, region), what), isError: false };
};

// How many identical confirming screenshots in a row are answered in words before the pixels are sent again: the
// agent saw the image one call ago, but a run of "unchanged" should not leave it reasoning from memory for long.
const MAX_UNCHANGED = 2;

// The look an action answers with: the same part of the screen the newest screenshot showed, or a sentence instead
// when not one pixel of it changed (which is itself the news: the click did nothing visible).
const confirmingLook = async (said: string, scopes: DeviceScopes): Promise<Record<string, unknown>> => {
    // The confirming frame needs the `screen` grant too; a device driven but not watched gets this sentence instead.
    if (scopes.screen !== "on") {
        return textResult(`${said} (No screenshot: "See the screen" is off for this device.)`);
    }
    await settle();
    const shot = await reshoot(desktop(), frames);
    if (shot.unchanged && frames.unchangedStreak() <= MAX_UNCHANGED) {
        return textResult(
            `${said} The screen did not change: screenshot ${shot.frame.id} is still exactly what it shows, so its coordinates still hold. If something should have happened, it did not.`,
        );
    }
    return { content: [{ type: "text", text: said }, ...(await shotContent(shot, "the same part of the screen as before"))], isError: false };
};

// The sandbox this call came from, which owns the programs it starts here: the router sets it around every MCP message.
const callerSandbox = (): string => calling.getStore()?.sandboxUrl ?? "local";

// One browser handle for the process's life: cheap, holds no socket until used, but remembers which tab the
// agent is working on so a sequence of calls reads as one session.
let webHandle: ReturnType<typeof browser> | undefined;
const web = (): ReturnType<typeof browser> => (webHandle ??= browser());

// The Android phones attached to this machine over adb: their frames and element refs live for the process's life,
// one set per phone, apart from the desktop's.
const android = createAndroid(machineAndroidDeps());

// A pixel pair, as the model is shown it and as the desktop takes it. Exactly two numbers.
const point = z.tuple([z.number(), z.number()]);

// A non-empty string: "" would reach the filesystem or the page as a lookup that cannot succeed, and whose
// failure says nothing about what went wrong.
const required = z.string().min(1);

// Which Android phone a call is about, on every android_* tool.
const phoneSerial = required
    .optional()
    .describe("The phone's serial from android_devices. Default: the only one attached; refused when several are, so pass it then.");

// The tool list. Descriptions carry the judgement calls the schema cannot: writes are off by default, there is
// no delete, one big command beats ten small ones over a link like this.
const TOOLS: readonly McpTool<DeviceScopes>[] = [
    tool({
        name: "describe",
        description:
            "What this device is: OS and version, CPU architecture, the exact shell run_command uses, the home directory, the folders you may touch, and which permissions are on. Call this once before your first command here, it is the difference between writing for this machine and guessing.",
        effect: "read",
        input: NO_ARGS,
        run: async (_args, scopes) => textResult(await describeText(scopes)),
    }),
    tool({
        name: "run_command",
        description:
            'Run a command on this device and get back its exit code, stdout and stderr. The shell is PowerShell on Windows and the user\'s login shell elsewhere (see describe). On a Windows PC with WSL, `in: "wsl:<distro>"` runs the command inside that distro through sh -lc instead, and inside a WSL distro `in: "windows"` runs it in PowerShell on the Windows side: the same PC, the other environment, with no quoting through the first shell. There is no terminal for anyone to type into: a command that prompts will fail rather than wait. At the deadline the command is stopped together with everything it started. The call returns once the command itself exits: a process it leaves running in the background keeps running, but nothing it prints after that is collected, so start one with its output redirected to a file (`> out.log 2>&1`). Very long output comes back as its start and its end, with the middle cut and counted. Commands that DELETE (a recursive delete, a formatted disk, a removed Docker volume) need this device\'s "Run destructive commands" switch, which is off unless its owner turned it on: they are refused with a message naming the switch, so ask the owner to turn it on rather than looking for a spelling that gets past it. Prefer one script that does the whole job over many small calls, every call is a network round trip to somebody\'s laptop.',
        effect: "destructive",
        input: z.object({
            command: required.describe("The command line to run, in the shell of the environment it runs in."),
            cwd: required
                .optional()
                .describe(
                    "Working directory. Here: must be inside the allowed folders, defaults to the first. Crossing with `in`: a path in that environment (a Linux path for a distro, a drive path like C:\\Users\\you for Windows), defaulting to its home.",
                ),
            in: required
                .optional()
                .describe(
                    'Where to run it: omit for this device. "wsl" (the default distro) or "wsl:<name>" on a Windows PC; "windows" inside a WSL distro. describe lists the distros and says which side this is.',
                ),
            timeoutMs: z
                .int()
                .positive()
                .max(MAX_TIMEOUT_MS)
                .default(DEFAULT_TIMEOUT_MS)
                .describe(`How long to wait before killing it. Default ${DEFAULT_TIMEOUT_MS}, maximum ${MAX_TIMEOUT_MS}.`),
        }),
        run: async ({ command, cwd, timeoutMs, in: target }, scopes) => {
            const result = await runCommand(
                { command, ...(cwd === undefined ? {} : { cwd }), ...(target === undefined ? {} : { in: target }), timeoutMs },
                scopes,
            );
            // A non-zero exit is a real answer, not a tool failure; the model reads the code and the streams and
            // decides.
            // Only a command that could not be run comes back as an error.
            return textResult(describeResult(result, timeoutMs));
        },
    }),
    tool({
        name: "read_file",
        description:
            "Read a text file on this device, within the folders this machine allows. Answers with the text, then a note giving the file's revision, which write_file and edit_file need to change it, and, when you read part of it, how much remains and the offset to continue from. Without offset and limit it is the whole file; one too long for a single answer is refused with its line count, to be read in parts. Line endings come back as LF whatever the file uses. Binary files are refused.",
        effect: "read",
        input: z.object({
            path: required,
            offset: z.int().positive().optional().describe("The line to start from, counting from 1. Default 1."),
            limit: z.int().positive().optional().describe("How many lines to read from there. Default: to the end of the file."),
        }),
        run: async ({ path, offset, limit }, scopes) => {
            const read = await readTextFile(path, { offset, limit }, scopes);
            // The text alone in the first block, which is where a program reading a file through this tool looks for it.
            return {
                content: [
                    { type: "text", text: read.text },
                    { type: "text", text: read.note },
                ],
                isError: false,
            };
        },
    }),
    tool({
        name: "write_file",
        description:
            "Create a file, or replace a file's whole contents. Replacing a file that exists needs the `revision` your last read_file, write_file or edit_file of it answered with, and is refused if the file has changed since; creating one needs none. A replaced file keeps its encoding (UTF-8, UTF-8 with BOM, UTF-16LE) and its line endings (CRLF or LF), whatever you send. To change part of a file, edit_file is cheaper and safer. Requires the 'Create and change files' permission, which is OFF unless the user turned it on.",
        // Replaces a whole file on a revision a partial read also gives, so what it replaced may be nowhere else.
        effect: "destructive",
        input: z.object({
            path: required,
            content: z.string(),
            revision: required
                .optional()
                .describe("The file's revision from read_file. Required to replace a file that exists; omit it to create one."),
        }),
        run: async ({ path, content, revision }, scopes) => textResult(await writeTextFile(path, content, revision, scopes)),
    }),
    tool({
        name: "edit_file",
        description:
            "Replace one exact piece of a file's text with another. `old_string` has to appear in the file exactly once, whitespace and indentation included, as read_file shows it (LF line endings): include a line or two around it to make it unique. Needs the `revision` your last read_file, write_file or edit_file of the file answered with, and is refused if the file has changed since; it answers with the new revision, so a run of edits needs no re-read. The file keeps its encoding and line endings. Requires the 'Create and change files' permission, which is OFF unless the user turned it on.",
        // What it replaces is in the call itself, so the reverse edit undoes it.
        effect: "write",
        input: z.object({
            path: required,
            old_string: required.describe("The text to replace, exactly as read_file shows it."),
            new_string: z.string().describe("What replaces it."),
            revision: required.describe("The file's revision from read_file, or from the write or edit that last changed it."),
        }),
        run: async ({ path, old_string: oldString, new_string: newString, revision }, scopes) =>
            textResult(await editTextFile(path, { oldString, newString, revision }, scopes)),
    }),
    tool({
        name: "list_dir",
        description: "List a directory, with each entry's kind, size and modification time.",
        effect: "read",
        input: z.object({ path: required }),
        run: async ({ path }, scopes) => textResult(JSON.stringify(await listDirectory(path, scopes), undefined, 2)),
    }),
    tool({
        name: "trash_file",
        description:
            "Move a file into this agent's trash folder, from which the user can restore it. There is deliberately no permanent-delete tool. Requires the 'Create and change files' permission.",
        // Nothing but the owner empties that folder, so the move is always undone by moving it back.
        effect: "write",
        input: z.object({ path: required }),
        run: async ({ path }, scopes) => textResult(await trashFile(path, scopes)),
    }),
    tool({
        name: "list_windows",
        description:
            "Every window open on this device: its app, title, size, position, and which one has focus. Call this before any GUI work, it is how you find the application you were asked about, and how you know where your typing will land. Requires the 'See the screen' permission.",
        effect: "read",
        input: NO_ARGS,
        run: async (_args, scopes) => textResult(await listWindows(desktop(), scopes, frames)),
    }),
    tool({
        name: "focus_window",
        description:
            "Bring a window to the front and give it the keyboard, by the id from list_windows. ALWAYS do this before typing: text goes to whatever window has focus, not to where the pointer is. Requires the 'Use the mouse and keyboard' permission.",
        effect: "write",
        input: z.object({ id: required }),
        run: async ({ id }, scopes) => textResult(await focusWindow(desktop(), id, scopes)),
    }),
    tool({
        name: "open",
        description:
            "Start an application, or open a URL or file with whatever this device has registered for it: the usual first step of a task ('open the browser at this page'). Use this rather than working out the platform's own incantation. Requires the 'Run commands' permission.",
        // Opening a script or an installer runs it.
        effect: "destructive",
        input: z.object({ target: required.describe("An application name, a file path, or a URL.") }),
        run: async ({ target }, scopes) => textResult(await openTarget(desktop(), target, scopes)),
    }),
    tool({
        name: "clipboard",
        description:
            "Read or replace this device's clipboard: the reliable way to move text between applications, and often easier than reading it off a screenshot. Reading needs 'See the screen'; writing needs 'Use the mouse and keyboard'.",
        // A write replaces what the owner had copied, which nothing else keeps.
        effect: "destructive",
        // `text` is required by the write and meaningless to the read, so it rides as a rule on the object rather than
        // splitting into two schemas: a union would publish `anyOf` at the root, not the `type: "object"` an MCP
        // client expects.
        input: z
            .object({
                action: z.enum(["read", "write"]),
                text: z.string().min(1).optional().describe("The text to put on the clipboard (write)."),
            })
            .refine((args) => args.action !== "write" || args.text !== undefined, {
                error: `"text" is what a write puts on the clipboard, a write without it would clear it, which read/write cannot express.`,
                path: ["text"],
            }),
        run: async ({ action, text }, scopes) =>
            action === "write" && text !== undefined
                ? textResult(await writeClipboard(desktop(), text, scopes))
                : textResult(await readClipboard(desktop(), scopes)),
    }),
    tool({
        name: "browser_open",
        description:
            "Open a page in a browser on this device and answer with what is on it: the page's title, its URL, and every element you can click or type into, each with a reference like [e12]. THIS IS THE RIGHT WAY TO USE A WEBSITE, act on elements by reference, never by clicking pixels, because references survive scrolling, resizing and re-rendering. The browser is a separate instance with its own profile, so the user's own tabs and session are untouched; the first time it opens they may need to sign in. Requires the 'Run commands' permission.",
        effect: "write",
        input: z.object({ url: required.describe("The page to open. A bare host like example.com is fine.") }),
        run: async ({ url }, scopes) => textResult(await openPage(web(), url, scopes)),
    }),
    tool({
        name: "browser_snapshot",
        description:
            "What the current page shows right now, with fresh [e…] references. Take one after anything that might have changed the page: references from an older snapshot are refused rather than clicking the wrong thing. Requires the 'See the screen' permission.",
        effect: "read",
        input: NO_ARGS,
        run: async (_args, scopes) => textResult(await snapshotPage(web(), scopes)),
    }),
    tool({
        name: "browser_read",
        description:
            "The current page as readable text: what a person would get by selecting all of it. Use this to ANSWER QUESTIONS about a page; use browser_snapshot when you intend to act on it. Requires the 'See the screen' permission.",
        effect: "read",
        input: NO_ARGS,
        run: async (_args, scopes) => textResult(await readPage(web(), scopes)),
    }),
    tool({
        name: "browser_click",
        description:
            "Click an element by its [e…] reference from the last snapshot. Answers with the page as it stands afterwards, so you see the result without asking. Requires the 'Use the mouse and keyboard' permission.",
        // A click can buy, send or delete on any site the owner signed into in that browser.
        effect: "destructive",
        input: z.object({ ref: required }),
        run: async ({ ref }, scopes) => textResult(await clickElement(web(), ref, scopes)),
    }),
    tool({
        name: "browser_fill",
        description:
            "Type into a field by its [e…] reference: replaces what is there, and fires the events a page's own JavaScript listens for (setting a value without them is how a filled form submits empty). Set submit to press Enter afterwards. Requires the 'Use the mouse and keyboard' permission.",
        // Replaces what the field held, and `submit` sends the form.
        effect: "destructive",
        input: z.object({
            ref: required,
            text: z.string(),
            submit: z.boolean().default(false).describe("Submit the form after typing. Default false."),
        }),
        run: async ({ ref, text, submit }, scopes) => textResult(await fillElement(web(), ref, text, submit, scopes)),
    }),
    tool({
        name: "browser_key",
        description:
            'Press a key on the page as a whole: "Return", "Escape", "Tab". For typing into a field use browser_fill. Requires the \'Use the mouse and keyboard\' permission.',
        // Enter submits and Delete deletes, whatever has focus.
        effect: "destructive",
        input: z.object({ key: required }),
        run: async ({ key }, scopes) => textResult(await pressKey(web(), key, scopes)),
    }),
    tool({
        name: "browser_tabs",
        description:
            "Every tab open in that browser, and which one these tools are acting on. Pass an id to `select` to switch. Reading the list needs 'See the screen'; switching needs 'Use the mouse and keyboard'.",
        // Listing reads, but `select` switches the tab every other browser tool acts on.
        effect: "write",
        input: z.object({ select: required.optional().describe("The id of the tab to switch to. Omit to just list them.") }),
        run: async ({ select }, scopes) => textResult(select === undefined ? await listTabs(web(), scopes) : await selectTab(web(), select, scopes)),
    }),
    tool({
        name: "device",
        description:
            "Use this device's mouse and keyboard: click what is on the screen, type into the focused window, press a key combination, scroll, drag. Coordinates are PIXELS IN THE LATEST SCREENSHOT, whatever it showed (the whole desktop, one display, a window or a zoomed region): take one first, read them off it, and pass its id as `frame`. Better still, point at an element ref from ui_elements, which needs no coordinate at all. Every action answers with a fresh screenshot of the same part of the screen, or says the screen did not change. Typing a command that would delete needs the 'Run destructive commands' switch, as running it would, and keys that lock or leave the desktop are refused. Requires the 'Use the mouse and keyboard' permission, which is OFF unless the user turned it on. Prefer a command over the GUI when both would work: a command is exact, and a click is a guess about where something is.",
        // The owner's own mouse and keyboard: anything they could do at the desk, a terminal included.
        effect: "destructive",
        input: z.object({
            action: z.enum([
                "mouse_move",
                "left_click",
                "right_click",
                "middle_click",
                "double_click",
                "left_click_drag",
                "type",
                "key",
                "scroll",
                "wait",
            ]),
            coordinate: point.optional().describe("[x, y] in pixels of the latest screenshot; every pointer action needs this or `element`."),
            element: required
                .optional()
                .describe("An element ref from ui_elements, pointed at instead of a coordinate: exact, wherever the element now is."),
            frame: required
                .optional()
                .describe(
                    "The id of the screenshot the coordinate was read off. Refused if a newer one was taken since, rather than clicking where the screen used to be.",
                ),
            to: point.optional().describe("[x, y] the drag ends at (left_click_drag)."),
            text: z.string().optional().describe('The text to type, or the key combination to press: "Return", "ctrl+c", "alt+Tab", "super+e".'),
            direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction. Default down."),
            amount: z.number().optional().describe("Wheel notches to scroll. Default 3."),
            ms: z.number().optional().describe('How long to wait (action "wait"). Default 400, maximum 10000.'),
        }),
        // Which coordinate an action needs, and whether it's on the screen, is act()'s to answer: it's the only caller
        // that knows the screen's size.
        run: async ({ frame, ...input }, scopes) => {
            const screen = desktop();
            await act(screen, input, scopes, undefined, pointingFor(screen, frames, frame, elementRefs));
            return await confirmingLook(describeAction(input), scopes);
        },
    }),
    tool({
        name: "screenshot",
        description:
            "Capture what is on this device's screen right now, as an image. Use it to read a dialog, check on a window, or see what the user is describing. A big or multi-monitor desktop is shrunk to fit what you can read whole, so small text may be unreadable: pass `display`, `window` or `region` to look closer at one part, at up to full resolution. Each screenshot has an id; coordinates you send to device are read in the latest one. Requires the 'See the screen' permission.",
        effect: "read",
        input: z
            .object({
                display: z.int().positive().optional().describe("One monitor, numbered as a whole-desktop screenshot lists them (1 is the first)."),
                window: required.optional().describe("One window, by its id from list_windows."),
                region: z
                    .tuple([z.number(), z.number(), z.number().positive(), z.number().positive()])
                    .optional()
                    .describe("[x, y, width, height] in pixels of the latest screenshot: zoom in on that part of it."),
            })
            .refine((args) => [args.display, args.window, args.region].filter((value) => value !== undefined).length <= 1, {
                error: "Pass at most one of display, window and region: each names a different part of the screen.",
            }),
        run: async ({ display, window, region }, scopes) =>
            await screenshotResult(
                scopes,
                display !== undefined
                    ? { kind: "display", index: display }
                    : window !== undefined
                      ? { kind: "window", id: window }
                      : region !== undefined
                        ? { kind: "region", rect: { x: region[0], y: region[1], width: region[2], height: region[3] } }
                        : { kind: "desktop" },
            ),
    }),
    tool({
        name: "ui_elements",
        description:
            "The controls of a window, read from its accessibility tree: each button, field, checkbox, menu item and link with its role, name, value and a ref like kd12. Clicking by ref is exact where a coordinate read off a shrunk screenshot is a guess, and ui_act works on a window in the background without moving the mouse. Defaults to the focused window. Big windows list their first controls; pass `query` to find one by name or value. On Windows through UI Automation; on Linux and macOS through cua-driver where the owner installed it, and otherwise refused with how to install it, so use screenshot coordinates there. Requires the 'See the screen' permission.",
        effect: "read",
        input: z.object({
            window: required.optional().describe("The window's id from list_windows. Default: the one with the keyboard."),
            query: required.optional().describe("Only elements whose role, name or value contains this (case-insensitive), labels included."),
        }),
        run: async ({ window, query }, scopes) => textResult(await listElements(desktop(), { window, query }, scopes, elementRefs, frames)),
    }),
    tool({
        name: "ui_act",
        description:
            "Act on an element from ui_elements without the pointer: invoke (press a button, follow a link), set_value (replace a field's text), toggle (a checkbox), expand/collapse (a menu, tree item or combo box), select (a list or tab item), or focus. Works on a background window and leaves the mouse where the user has it. An element offers only the actions ui_elements lists beside it. Answers with a fresh screenshot. Requires the 'Use the mouse and keyboard' permission.",
        // A press can send, buy or delete as surely as a click.
        effect: "destructive",
        input: z.object({
            element: required.describe("The element's ref from the latest ui_elements, like kd12."),
            action: z.enum(["invoke", "set_value", "toggle", "expand", "collapse", "select", "focus"]),
            value: z.string().optional().describe("The text set_value writes; required for set_value."),
        }),
        run: async ({ element, action, value }, scopes) =>
            await confirmingLook(await actOnElement(desktop(), { element, action, value }, scopes, elementRefs), scopes),
    }),
    // An Android phone attached to this machine through adb (USB or wireless debugging), driven like the desktop.
    tool({
        name: "android_devices",
        description:
            'The Android phones and emulators attached to this device through adb (USB or wireless debugging), as JSON: each one\'s serial, state, model, product, transport (usb, wireless, emulator), and for a ready one its Android version, SDK level and screen size. A state other than "device" comes with what to do about it: "unauthorized" means the person must unlock the phone and accept the "Allow USB debugging?" prompt on it. Call this first: the other android_* tools take a `serial`, needed when several are attached. Requires the \'Run commands\' permission.',
        effect: "read",
        input: NO_ARGS,
        run: async (_args, scopes) => textResult(await android.devices(scopes)),
    }),
    tool({
        name: "android_screenshot",
        description:
            "Capture the attached Android phone's screen, as an image with an id (phone-…), shrunk to fit what you can read. Coordinates you send to android_act are read in the newest phone screenshot, never in a desktop screenshot, and the two never stand in for each other. An app that blocks screenshots (banking, DRM video) shows as black. Requires the 'See the screen' permission.",
        effect: "read",
        input: z.object({ serial: phoneSerial }),
        run: async ({ serial }, scopes) => await android.screenshot(serial, scopes),
    }),
    tool({
        name: "android_ui_elements",
        description:
            "The phone screen's controls and text, read from Android's accessibility dump (uiautomator): each with a ref like e12, its class, text, description, resource id, where its centre falls in a phone screenshot, and whether it is clickable, scrollable, checked or focused. Tapping by ref (android_act with `element`) is exact where a coordinate read off a shrunk screenshot is a guess, so list first and prefer refs. Refs hold until the next listing; list again after anything that changes the screen. Pass `query` to find elements by text, description, id or class. A screen that never stops moving (a video, a game) cannot be dumped: use android_screenshot there. Requires the 'See the screen' permission.",
        effect: "read",
        input: z.object({
            serial: phoneSerial,
            query: required.optional().describe("Only elements whose text, description, resource id or class contains this (case-insensitive)."),
        }),
        run: async ({ serial, query }, scopes) => textResult(await android.uiElements({ serial, query }, scopes)),
    }),
    tool({
        name: "android_act",
        description:
            "Touch the attached Android phone through adb: tap, long_press or swipe at an element ref from android_ui_elements (`element`) or at [x, y] in the newest phone screenshot (`coordinate`, with its id as `frame`); type text into the focused field; press a key (an Android key code like ENTER, BACK, VOLUME_UP, or its number); back, home and recents; scroll a list (`direction`, `amount` swipes, at an element or the middle of the screen). `type` carries printable ASCII only (a newline presses Enter); other characters are refused by name. Keys that turn the screen off or lock the phone (POWER, SLEEP) are refused: nothing here can unlock it again. Typing a command that would delete needs the 'Run destructive commands' switch, as on the desktop. Every action answers with a fresh phone screenshot, or says the screen did not change. Requires the 'Use the mouse and keyboard' permission.",
        // Whatever the owner could do with the phone in their hand: send, buy, delete.
        effect: "destructive",
        input: z.object({
            serial: phoneSerial,
            action: z.enum(["tap", "long_press", "swipe", "type", "key", "back", "home", "recents", "scroll"]),
            element: required.optional().describe("An element ref from the latest android_ui_elements, like e12: tapped at its centre."),
            coordinate: point
                .optional()
                .describe("[x, y] in pixels of the newest phone screenshot; tap, long_press and swipe need this or `element`."),
            frame: required
                .optional()
                .describe("The id of the phone screenshot the coordinates were read off (phone-…). Refused if a newer one was taken since."),
            to: point.optional().describe("[x, y] where a swipe lifts, in the same screenshot."),
            text: z.string().optional().describe('The text to type, or the key to press: "ENTER", "BACK", "VOLUME_UP", "TAB", "66".'),
            direction: z.enum(["up", "down", "left", "right"]).optional().describe("Which way to scroll the content. Default down."),
            amount: z.int().positive().max(10).optional().describe("How many swipes to scroll by. Default 1."),
            ms: z.int().positive().max(10_000).optional().describe("How long a swipe or long_press lasts, in milliseconds. Default 300 and 800."),
        }),
        run: async (input, scopes) => await android.act(input, scopes),
    }),
    tool({
        name: "android_shell",
        description:
            "Run a command in the attached Android phone's own shell (`adb shell`), as the shell user, and get back its exit code, stdout and stderr: `pm list packages`, `am start -n <package>/<activity>`, `dumpsys battery`, `getprop`, `ls /sdcard`. Commands that lose something the phone does not give back need the 'Run destructive commands' switch, which is off unless its owner turned it on: deleting recursively, `pm uninstall`, `pm clear`, `settings put`, `svc`, `reboot`, a wipe. Note that `svc wifi disable` over wireless debugging cuts the link you are using. There is no terminal: a command that waits for input is stopped at the deadline. Requires the 'Run commands' permission.",
        effect: "destructive",
        input: z.object({
            serial: phoneSerial,
            command: required.describe("The command line, as the phone's sh reads it."),
            timeoutMs: z
                .int()
                .positive()
                .max(MAX_ANDROID_TIMEOUT_MS)
                .default(DEFAULT_ANDROID_TIMEOUT_MS)
                .describe(`How long to wait before stopping it. Default ${DEFAULT_ANDROID_TIMEOUT_MS}, maximum ${MAX_ANDROID_TIMEOUT_MS}.`),
        }),
        run: async ({ serial, command, timeoutMs }, scopes) => textResult(await android.shell({ serial, command, timeoutMs }, scopes)),
    }),
    tool({
        name: "android_install",
        description:
            "Install an APK file from this device onto the attached Android phone (`adb install -r`): a newer build of an app already there replaces it and keeps its data. The path must be inside the folders this device allows. The phone may ask its owner to confirm an install from a computer. Requires the 'Run commands' and 'Create and change files' permissions.",
        // Replaces the installed version, which nothing here can put back.
        effect: "destructive",
        input: z.object({ serial: phoneSerial, path: required.describe("The .apk file on this device.") }),
        run: async ({ serial, path }, scopes) => textResult(await android.install({ serial, path }, scopes)),
    }),
    tool({
        name: "android_logcat",
        description:
            "The tail of the attached Android phone's log (`adb logcat -d`): what an app printed, and the stack trace of a crash. Narrow it to one running app with `package`, to one tag with `tag`, or to a minimum `priority` (E for errors only). Requires the 'Run commands' permission.",
        effect: "read",
        input: z.object({
            serial: phoneSerial,
            lines: z
                .int()
                .positive()
                .max(MAX_ANDROID_LOG_LINES)
                .optional()
                .describe(`How many of the last lines to read. Default ${DEFAULT_ANDROID_LOG_LINES}, maximum ${MAX_ANDROID_LOG_LINES}.`),
            package: required.optional().describe("Only lines from this running app's process, like com.example.app."),
            tag: required.optional().describe("Only lines with this tag, like ActivityManager or AndroidRuntime."),
            priority: z.enum(["V", "D", "I", "W", "E", "F"]).optional().describe("The lowest priority shown: V, D, I, W, E or F."),
        }),
        run: async ({ serial, lines, package: app, tag, priority }, scopes) =>
            textResult(await android.logcat({ serial, lines, package: app, tag, priority }, scopes)),
    }),
    tool({
        name: "app_start",
        description:
            'Start a program on this device and keep it running after the call returns: an app to look at, click through and read the output of, which run_command (it waits, and stops the command at its deadline) is wrong for. Pass the path `devices push <this device> <build>` printed in the sandbox shell, or the program inside a pushed folder; a program the sandbox pushed needs this device\'s "Run programs this sandbox sends" switch, any other program "Run commands". Its stdout and stderr go to a log of its own (app_logs). A program that falls over within a second or two is answered with its exit code, said in words (a missing DLL, an architecture mismatch), and its last output. Answers with the run id the other app_* tools take.',
        effect: "destructive",
        input: z.object({
            program: required.describe("A full path (a pushed build, or any program on this device), or a bare name found on its PATH."),
            args: z.array(z.string()).max(100).optional().describe("Arguments, each passed as is, with no shell between."),
            cwd: required.optional().describe("Working directory. Default: the program's own folder."),
            env: z.record(z.string(), z.string()).optional().describe("Environment variables to set on top of the agent's own."),
            name: required.optional().describe("What to call this run in app_status. Default: the program's name."),
        }),
        run: async (request, scopes) => textResult(await startApp(request, scopes, callerSandbox())),
    }),
    tool({
        name: "app_status",
        description:
            "The programs this sandbox started on this device, running and ended, and the builds it pushed here. With an id: that run's state, how it ended (exit code in words), the windows it and the processes it started have open (ids for screenshot, ui_elements, focus_window), and its last output.",
        effect: "read",
        input: z.object({ id: required.optional().describe("A run id from app_start. Omit for the list.") }),
        run: async ({ id }, scopes) => textResult(await appStatus(id, scopes, callerSandbox(), desktop)),
    }),
    tool({
        name: "app_logs",
        description: "What a program started with app_start printed (stdout and stderr together), from its end. A GUI program often prints nothing; its exit code is in app_status.",
        effect: "read",
        input: z.object({
            id: required.describe("The run id from app_start."),
            lines: z
                .int()
                .positive()
                .max(MAX_APP_LOG_LINES)
                .default(DEFAULT_APP_LOG_LINES)
                .describe(`How many lines from the end. Default ${DEFAULT_APP_LOG_LINES}, maximum ${MAX_APP_LOG_LINES}.`),
            grep: required.optional().describe("Only lines matching this regular expression (case-insensitive)."),
        }),
        run: async ({ id, lines, grep }, scopes) => textResult(await appLogs(id, lines, grep, scopes, callerSandbox())),
    }),
    tool({
        name: "app_stop",
        description:
            "Stop a program started with app_start, together with every process it started. It is asked to close first, as its close button would, and forced after five seconds; `force` skips the asking.",
        effect: "write",
        input: z.object({ id: required.describe("The run id from app_start."), force: z.boolean().default(false) }),
        run: async ({ id, force }, scopes) => textResult(await appStop(id, force, scopes, callerSandbox())),
    }),
    tool({
        name: "list_sandboxes",
        description:
            "The Intentic sandboxes on this device, as JSON, as the device's `ic` reports them: each one's slug, whether it is running, whether its tunnel is up, and under `resources` its share of this machine as docker enforces it (memory cap in bytes, CPU cap, privileged, GPU, and which of those the approved environment demands versus the owner asked for), the shape it runs with (`shape`: memoryGib, cpus, privileged, gpu as the owner asked; null is the default) and, when one is saved, the shape its next restart applies (`desired`). `staged` names an update downloaded and waiting. From a current `ic` also: `version`, `parked` (a swap was interrupted and the sandbox is down; manage_sandbox start brings it back), `probationUntil` (the host is still watching a new version and goes back by itself if it fails), `lastUpdate` (what the host last did about its version, and why) and `rollbackTargets` (what swap_sandbox rollback can return to, newest first). Only sandbox containers; nothing else on the machine is listed. Requires 'Run commands' or 'Manage sandboxes on this device'.",
        effect: "read",
        input: NO_ARGS,
        run: async (_args, scopes) => textResult(await listSandboxes(scopes)),
    }),
    tool({
        name: "manage_sandbox",
        description:
            "Start, stop or restart one Intentic sandbox on this device, by its slug from list_sandboxes. Stopping one interrupts whoever is working in it, and stopping the sandbox you are calling from severs your own connection. All three go through the device's `ic`. When a shape is saved for the sandbox's next restart (reshape_sandbox with `when: \"nextRestart\"`, shown as `resources.desired`), start and restart recreate it with that shape, which takes about a minute; stop keeps it waiting. Requires the 'Manage sandboxes on this device' permission, which is OFF unless the user turned it on.",
        effect: "write",
        input: z.object({ op: SandboxOpSchema, slug: required.describe("The sandbox's slug, from list_sandboxes.") }),
        run: async ({ op, slug }, scopes) => textResult(await manageSandbox(op, slug, scopes)),
    }),
    // The three flows that run `ic`, as an MCP call answer once at the end with everything printed. The browser
    // route (`runSandboxFlow`) passes a line callback instead so it can stream, same functions either way.
    tool({
        name: "swap_sandbox",
        description:
            "Move one Intentic sandbox on this device onto a different image: 'update' pulls the newest image of its release channel, 'rollback' returns it to the image it ran before its last update, and 'rebuild' rebuilds the owner-approved environment overlay. Files (/work) and history are kept in all three. Takes MINUTES, it pulls an image and recreates the container, and the sandbox is down while it happens. 'prepare' is the exception and the one to reach for first: it does the downloading and building of the next update WITHOUT touching the container, so the sandbox keeps running throughout and the 'update' that follows is a restart of seconds instead of a wait of minutes. Requires the 'Manage sandboxes on this device' permission.",
        // Files and history are kept, and 'rollback' returns the image an update replaced.
        effect: "write",
        input: z.object({
            op: SandboxSwapSchema,
            slug: required.describe("The sandbox's slug, from list_sandboxes."),
            hash: required.optional().describe("sha256 of the approved overlay, required for 'rebuild', ignored otherwise."),
            to: required
                .optional()
                .describe(
                    "'rollback' only: a version or image from the sandbox's `rollbackTargets` (list_sandboxes) to go back to instead of the previous one.",
                ),
        }),
        run: async ({ op, slug, hash, to }, scopes) => textResult(await swapSandbox(op, slug, hash, scopes, () => {}, to)),
    }),
    tool({
        name: "reshape_sandbox",
        description:
            "Set how much of this device one Intentic sandbox may use, or its privileges: a memory cap in whole GiB, a CPU cap in whole cores, whether the container runs privileged, and whether this device's NVIDIA GPUs are passed through. Give the fields that should change and `when`; a field left out keeps the value already saved for the next restart, else the one it runs with. `null` for a cap means back to the default (the memory share derived from this machine; every core). `when: \"now\"` RESTARTS the sandbox onto the same image — about a minute, whoever is working in it is interrupted, and reshaping the sandbox you are calling from severs your own connection until it is back — and the values then survive every later update. `when: \"nextRestart\"` restarts nothing: the device's `ic` checks the shape against the sandbox's image and saves it, and the sandbox's next restart through ic applies it (manage_sandbox start or restart, or swap_sandbox update, rollback or rebuild; not Docker restarting the container by itself). `forget: true`, with no fields and no `when`, drops what is saved. A call with no fields and no `forget` is refused and changes nothing. A privilege the sandbox's approved environment demands (the Docker capability's --privileged) cannot be withdrawn here, only the owner's own ask. Requires the 'Manage sandboxes on this device' permission.",
        effect: "write",
        input: SandboxResourcesAskFieldsSchema.extend({
            slug: required.describe("The sandbox's slug, from list_sandboxes."),
            when: SandboxShapeWhenSchema.optional().describe(
                "`now` restarts onto the shape; `nextRestart` saves it for the sandbox's next restart through ic. Required with any field.",
            ),
            forget: z.boolean().optional().describe("Drop the shape saved for the next restart. Takes no fields and no `when`."),
        }),
        run: async ({ slug, when, forget, ...fields }, scopes) => {
            const named = Object.values(fields).some((value) => value !== undefined);
            if (forget === true) {
                if (named || when !== undefined) {
                    throw new Error("`forget` drops what is saved and takes nothing else: call again with only the slug and `forget: true`.");
                }
                return textResult(await forgetShape(slug, scopes, () => {}));
            }
            if (!named || when === undefined) {
                throw new Error(
                    'Nothing was changed: give at least one field (memoryGib, cpus, privileged, gpu) and `when` ("now" or "nextRestart"), or `forget: true`. To apply what is saved, use manage_sandbox restart.',
                );
            }
            return textResult(await shapeSandbox(slug, fields, when, scopes, () => {}));
        },
    }),
    tool({
        name: "remove_sandbox",
        description:
            "Remove one Intentic sandbox from this device: its container stops and leaves the listing. Its files and its history are kept for a week, so `ic sandbox restore <slug>` on the device brings it back whole; after that week they are deleted for good. This is not what stopping it does, so confirm with the user before calling it. Requires the 'Manage sandboxes on this device' permission, which is OFF unless the user turned it on.",
        effect: "destructive",
        input: z.object({ slug: required.describe("The sandbox's slug, from list_sandboxes.") }),
        run: async ({ slug }, scopes) => textResult(await removeSandbox(slug, scopes, () => {})),
    }),
    tool({
        name: "sandbox_logs",
        description:
            "The tail of one Intentic sandbox's container log on this device: how you find out why it will not start or what it did before it stopped. Requires 'Run commands' or 'Manage sandboxes on this device'.",
        effect: "read",
        input: z.object({
            slug: required.describe("The sandbox's slug, from list_sandboxes."),
            // The prose and the rule come off the same two numbers, so the sentence the model reads cannot promise a
            // ceiling other than the one it is held to.
            lines: z
                .int()
                .positive()
                .max(MAX_LOG_LINES)
                .optional()
                .describe(`How many trailing lines to answer with. Default ${DEFAULT_LOG_LINES}, maximum ${MAX_LOG_LINES}.`),
        }),
        run: async ({ slug, lines }, scopes) => textResult(await sandboxLogs(slug, lines, scopes)),
    }),
    tool({
        name: "diagnose_sandbox",
        description:
            "Check every link of one Intentic sandbox's reachability chain on this device (Docker, its container, its daemon, its registration with the platform, the network, the tunnel) and say what is broken and what fixes it, as JSON from the device's `ic sandbox doctor`. Changes nothing, and answers while Docker is down, when list_sandboxes cannot: how you find out why a sandbox on this device cannot be reached. Requires 'Run commands' or 'Manage sandboxes on this device'.",
        effect: "read",
        input: z.object({ slug: required.describe("The sandbox's slug, from list_sandboxes, or the first label of its address.") }),
        run: async ({ slug }, scopes) => textResult(await diagnoseSandbox(slug, scopes)),
    }),
];

// Arguments are logged verbatim except typed text, which is redacted to its length: a `device` or `android_act` "type",
// `clipboard` "write" or `ui_act` set_value call routinely carries a password. A key combination is not redacted; there is nothing
// in it to leak.
const auditDetail = (name: string, args: McpAuditEntry["args"]): string => {
    const redact =
        ((name === "device" || name === "android_act") && args["action"] === "type") ||
        (name === "clipboard" && args["action"] === "write") ||
        name === "browser_fill";
    const safe = redact
        ? { ...args, text: `<${String(args["text"] ?? "").length} characters>` }
        : name === "ui_act" && args["value"] !== undefined
          ? { ...args, value: `<${String(args["value"]).length} characters>` }
          : args;
    return JSON.stringify(safe).slice(0, 500);
};

// Handle one JSON-RPC message against the grant as it stands at that moment.
export const handleMcpMessage = createMcpServer<DeviceScopes>({
    serverInfo: () => ({ name: "intentic-machine", version: MACHINE_VERSION }),
    tools: TOOLS,
    noSuchTool: (name) => `This device has no tool called "${name}".`,
    refused: (error) => error instanceof ScopeError,
    errorMessage,
    audit: ({ tool: name, args, ok, failure }) =>
        audit({
            tool: name,
            ok,
            detail: failure === undefined ? auditDetail(name, args) : `${failure.refused ? "refused" : "failed"}: ${failure.message}`,
        }),
});
