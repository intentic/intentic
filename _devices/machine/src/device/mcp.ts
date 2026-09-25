import { errorMessage } from "@intentic/base/errors";
import { browser } from "@intentic/browser";
import { desktop, pngSize } from "@intentic/desktop-automation";
import { type DeviceScopes, SandboxResourcesAskFieldsSchema, SandboxShapeWhenSchema } from "@intentic/sandbox-contract";
import { createMcpServer, type McpTool, textResult, tool } from "@intentic/sandbox-contract/peer-mcp-server";
import { z } from "zod";
import { audit } from "./audit.js";
import { assertScope, ScopeError } from "./policy.js";
import { describeText } from "./tools/describe.js";
import { editTextFile, listDirectory, readTextFile, trashFile, writeTextFile } from "./tools/files.js";
import { focusWindow, listWindows, openTarget, readClipboard, writeClipboard } from "./tools/apps.js";
import { clickElement, fillElement, listTabs, openPage, pressKey, readPage, selectTab, snapshotPage } from "./tools/browser.js";
import { act, describeAction, settle } from "./tools/device.js";
import {
    DEFAULT_LOG_LINES,
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
import { MACHINE_VERSION } from "../version.js";

// The tool surface of a connected device, served by sandbox-contract's peer-mcp-server (dispatch, schema-once
// `tool()`, "a failed tool is not a failed call"). Descriptions here carry the judgement calls the schema
// can't; every tool reads the live grant per call.

const NO_ARGS = z.object({});

// The screen plus its size: the frame every coordinate the agent sends back is in. A click outside the bounds
// is refused rather than clamped (tools/device.ts).
const screenshotResult = async (scopes: DeviceScopes): Promise<Record<string, unknown>> => {
    assertScope(scopes, "screen");
    const screen = desktop();
    const png = await screen.capture();
    const { width, height } = pngSize(png);
    return {
        content: [
            { type: "text", text: `Screen is ${width}×${height}. Coordinates for the device tool are pixels in this image.` },
            { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        ],
        isError: false,
    };
};

// One browser handle for the process's life: cheap, holds no socket until used, but remembers which tab the
// agent is working on so a sequence of calls reads as one session.
let webHandle: ReturnType<typeof browser> | undefined;
const web = (): ReturnType<typeof browser> => (webHandle ??= browser());

// A pixel pair, as the model is shown it and as the desktop takes it. Exactly two numbers.
const point = z.tuple([z.number(), z.number()]);

// A non-empty string: "" would reach the filesystem or the page as a lookup that cannot succeed, and whose
// failure says nothing about what went wrong.
const required = z.string().min(1);

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
            "Run a command on this device and get back its exit code, stdout and stderr. The shell is PowerShell on Windows and the user's login shell elsewhere (see describe). On a Windows PC with WSL, `in: \"wsl:<distro>\"` runs the command inside that distro through sh -lc instead, and inside a WSL distro `in: \"windows\"` runs it in PowerShell on the Windows side: the same PC, the other environment, with no quoting through the first shell. There is no terminal for anyone to type into: a command that prompts will fail rather than wait. At the deadline the command is stopped together with everything it started. The call returns once the command itself exits: a process it leaves running in the background keeps running, but nothing it prints after that is collected, so start one with its output redirected to a file (`> out.log 2>&1`). Very long output comes back as its start and its end, with the middle cut and counted. Commands that DELETE (a recursive delete, a formatted disk, a removed Docker volume) need this device's \"Run destructive commands\" switch, which is off unless its owner turned it on: they are refused with a message naming the switch, so ask the owner to turn it on rather than looking for a spelling that gets past it. Prefer one script that does the whole job over many small calls, every call is a network round trip to somebody's laptop.",
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
            const result = await runCommand({ command, ...(cwd === undefined ? {} : { cwd }), ...(target === undefined ? {} : { in: target }), timeoutMs }, scopes);
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
            revision: required.optional().describe("The file's revision from read_file. Required to replace a file that exists; omit it to create one."),
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
        run: async (_args, scopes) => textResult(await listWindows(desktop(), scopes)),
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
            "Use this device's mouse and keyboard: click what is on the screen, type into the focused window, press a key combination, scroll, drag. Coordinates are PIXELS IN THE LAST SCREENSHOT, take one first and read them off it. Every action answers with a fresh screenshot so you can see what happened. Requires the 'Use the mouse and keyboard' permission, which is OFF unless the user turned it on. Prefer a command over the GUI when both would work: a command is exact, and a click is a guess about where something is.",
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
            coordinate: point.optional().describe("[x, y] in screenshot pixels, required for every pointer action."),
            to: point.optional().describe("[x, y] the drag ends at (left_click_drag)."),
            text: z.string().optional().describe('The text to type, or the key combination to press: "Return", "ctrl+c", "alt+Tab", "super+e".'),
            direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction. Default down."),
            amount: z.number().optional().describe("Wheel notches to scroll. Default 3."),
            ms: z.number().optional().describe('How long to wait (action "wait"). Default 400, maximum 10000.'),
        }),
        // Which coordinate an action needs, and whether it's on the screen, is act()'s to answer: it's the only caller
        // that knows the screen's size.
        run: async (input, scopes) => {
            await act(desktop(), input, scopes);
            // The confirming frame needs the `screen` grant too; a device driven but not watched gets this sentence
            // instead.
            if (scopes.screen !== "on") {
                return textResult(`${describeAction(input)} (No screenshot: "See the screen" is off for this device.)`);
            }
            await settle();
            const shot = await screenshotResult(scopes);
            return { content: [{ type: "text", text: describeAction(input) }, ...(shot["content"] as unknown[])], isError: false };
        },
    }),
    tool({
        name: "screenshot",
        description:
            "Capture what is on this device's screen right now, as an image. Use it to read a dialog, check on a window, or see what the user is describing. Requires the 'See the screen' permission.",
        effect: "read",
        input: NO_ARGS,
        run: async (_args, scopes) => await screenshotResult(scopes),
    }),
    tool({
        name: "list_sandboxes",
        description:
            "The Intentic sandboxes on this device, as JSON, as the device's `ic` reports them: each one's slug, whether it is running, whether its tunnel is up, and under `resources` its share of this machine as docker enforces it (memory cap in bytes, CPU cap, privileged, GPU, and which of those the approved environment demands versus the owner asked for), the shape it runs with (`shape`: memoryGib, cpus, privileged, gpu as the owner asked; null is the default) and, when one is saved, the shape its next restart applies (`desired`). `staged` names an update downloaded and waiting. Only sandbox containers; nothing else on the machine is listed. Requires 'Run commands' or 'Manage sandboxes on this device'.",
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
        }),
        run: async ({ op, slug, hash }, scopes) => textResult(await swapSandbox(op, slug, hash, scopes, () => {})),
    }),
    tool({
        name: "reshape_sandbox",
        description:
            "Set how much of this device one Intentic sandbox may use, or its privileges: a memory cap in whole GiB, a CPU cap in whole cores, whether the container runs privileged, and whether this device's NVIDIA GPUs are passed through. Give the fields that should change and `when`; a field left out keeps the value already saved for the next restart, else the one it runs with. `null` for a cap means back to the default (the memory share derived from this machine; every core). `when: \"now\"` RESTARTS the sandbox onto the same image — about a minute, whoever is working in it is interrupted, and reshaping the sandbox you are calling from severs your own connection until it is back — and the values then survive every later update. `when: \"nextRestart\"` restarts nothing: the device's `ic` checks the shape against the sandbox's image and saves it, and the sandbox's next restart through ic applies it (manage_sandbox start or restart, or swap_sandbox update, rollback or rebuild; not Docker restarting the container by itself). `forget: true`, with no fields and no `when`, drops what is saved. A call with no fields and no `forget` is refused and changes nothing. A privilege the sandbox's approved environment demands (the Docker capability's --privileged) cannot be withdrawn here, only the owner's own ask. Requires the 'Manage sandboxes on this device' permission.",
        effect: "write",
        input: SandboxResourcesAskFieldsSchema.extend({
            slug: required.describe("The sandbox's slug, from list_sandboxes."),
            when: SandboxShapeWhenSchema.optional().describe("`now` restarts onto the shape; `nextRestart` saves it for the sandbox's next restart through ic. Required with any field."),
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
                throw new Error("Nothing was changed: give at least one field (memoryGib, cpus, privileged, gpu) and `when` (\"now\" or \"nextRestart\"), or `forget: true`. To apply what is saved, use manage_sandbox restart.");
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
];

// Arguments are logged verbatim except typed text, which is redacted to its length: a `device` "type" or
// `clipboard` "write" call routinely carries a password. A key combination is not redacted; there is nothing
// in it to leak.
const auditDetail = (name: string, args: Record<string, unknown>): string => {
    const redact =
        (name === "device" && args["action"] === "type") || (name === "clipboard" && args["action"] === "write") || name === "browser_fill";
    const safe = redact ? { ...args, text: `<${String(args["text"] ?? "").length} characters>` } : args;
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
        audit({ tool: name, ok, detail: failure === undefined ? auditDetail(name, args) : `${failure.refused ? "refused" : "failed"}: ${failure.message}` }),
});
