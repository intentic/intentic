import { browser } from "@intentic/browser";
import { desktop, pngSize } from "@intentic/desktop";
import { type HostScopes, MCP_PROTOCOL_VERSION } from "@intentic/sandbox-contract";
import { z } from "zod";
import { audit } from "./audit.js";
import { assertScope, ScopeError } from "./policy.js";
import { describeText } from "./tools/describe.js";
import { listDirectory, readTextFile, trashFile, writeTextFile } from "./tools/files.js";
import { focusWindow, listWindows, openTarget, readClipboard, writeClipboard } from "./tools/apps.js";
import { clickElement, fillElement, listTabs, openPage, pressKey, readPage, selectTab, snapshotPage } from "./tools/browser.js";
import { act, describeAction, settle } from "./tools/computer.js";
import {
    DEFAULT_LOG_LINES,
    listSandboxes,
    manageSandbox,
    MAX_LOG_LINES,
    removeSandbox,
    SandboxOpSchema,
    SandboxSwapSchema,
    sandboxLogs,
    swapSandbox,
} from "./tools/sandboxes.js";
import { DEFAULT_TIMEOUT_MS, describeResult, MAX_TIMEOUT_MS, runCommand } from "./tools/shell.js";
import { HOST_VERSION } from "./version.js";

/* The MCP server, running HERE, on the machine, not in the sandbox.
 *
 * The sandbox's daemon forwards JSON-RPC verbatim and interprets none of it, so this file is the entire tool
 * surface: what this computer can do is decided by the binary installed on it, and a machine that upgrades
 * learns new tools without anything changing in the sandbox. That is the reason for the split, the alternative
 * (schemas in the daemon, execution here) makes every new tool a coordinated release of two products.
 *
 * The protocol implemented is the subset that a Streamable HTTP client actually uses against a stateless server:
 * initialize, tools/list, tools/call, ping, and notifications (which get no reply). Anything else answers
 * "method not found", which is the correct JSON-RPC response and not an error worth logging.
 *
 * A FAILED TOOL IS NOT A FAILED CALL. Every error, a refused scope, a missing file, a command that exited 1,
 * an argument that does not typecheck, comes back as a normal result with isError, because that is what a model
 * can read and act on; a JSON-RPC error surfaces as a transport fault and invites a retry loop against a
 * computer that will refuse it exactly the same way the second time.
 *
 * EACH TOOL'S ARGUMENTS ARE DESCRIBED ONCE. The schema below is what the model is shown (`tools/list` publishes
 * it as JSON Schema) AND what an arriving call is checked against, so the advertised shape and the accepted one
 * cannot drift, the failure mode of writing both by hand, where a renamed field keeps validating and the model
 * keeps being told about the old name. It also means a handler receives its arguments typed: no per-tool
 * coercion helpers, and no casting an untyped bag into the shape it was hoped to have. */

interface Tool {
    readonly name: string;
    readonly description: string;
    // JSON Schema for `tools/list`, derived from the zod schema once at module load rather than per request.
    readonly inputSchema: Record<string, unknown>;
    readonly call: (args: unknown, scopes: HostScopes) => Promise<Record<string, unknown>>;
}

const textResult = (text: string, isError = false): Record<string, unknown> => ({ content: [{ type: "text", text }], isError });

/* One tool, from the only description of its arguments there is. The generic is what carries the schema's type
 * through to the handler's parameter; `Tool` erases it again, because the dispatch table holds all 24 and the
 * parse is what re-establishes the type at the boundary.
 *
 * `$schema` is dropped: the enclosing tool entry already says what this document is, and MCP clients read the
 * keywords rather than the dialect declaration. */
const tool = <Schema extends z.ZodType>(spec: {
    name: string;
    description: string;
    input: Schema;
    run: (args: z.output<Schema>, scopes: HostScopes) => Promise<Record<string, unknown>>;
}): Tool => {
    const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(spec.input, { io: "input" });
    return {
        name: spec.name,
        description: spec.description,
        inputSchema,
        call: async (args, scopes) => {
            const parsed = spec.input.safeParse(args);
            // Readable enough for a model to fix its own call: which field, and what was expected there.
            return parsed.success ? await spec.run(parsed.data, scopes) : textResult(z.prettifyError(parsed.error), true);
        },
    };
};

const NO_ARGS = z.object({});

/* The screen, plus the size of it. The dimensions ride along because they are the frame every coordinate the
 * agent sends back is in, a model that can see the image but not its bounds guesses at the edges, and a click
 * outside them is refused rather than clamped (tools/computer.ts). */
const screenshotResult = async (scopes: HostScopes): Promise<Record<string, unknown>> => {
    assertScope(scopes, "screen");
    const screen = desktop();
    const png = await screen.capture();
    const { width, height } = pngSize(png);
    return {
        content: [
            { type: "text", text: `Screen is ${width}×${height}. Coordinates for the computer tool are pixels in this image.` },
            { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        ],
        isError: false,
    };
};

/* ONE browser handle for the life of this process. The handle is cheap, it holds no socket until something is
 * asked of it, but it remembers WHICH TAB the agent is working on, and that continuity is the whole reason a
 * sequence of calls reads as one session rather than as several strangers arriving at the same browser. */
let webHandle: ReturnType<typeof browser> | undefined;
const web = (): ReturnType<typeof browser> => (webHandle ??= browser());

// A pixel pair, as the model is shown it and as the desktop takes it. Exactly two numbers, so a three-element
// array is refused here instead of being half-read downstream.
const point = z.tuple([z.number(), z.number()]);

// The path-shaped and reference-shaped arguments: a non-empty string, because "" reaches the filesystem or the
// page as a lookup that cannot succeed and whose failure says nothing about what went wrong.
const required = z.string().min(1);

/* The tool list, written for a reader who has never seen this machine. Descriptions carry the judgement calls
 * the schema cannot: that writes are off by default, that there is no delete, that one big command beats ten
 * small ones over a link like this. */
const TOOLS: readonly Tool[] = [
    tool({
        name: "describe",
        description:
            "What this computer is: OS and version, CPU architecture, the exact shell run_command uses, the home directory, the folders you may touch, and which permissions are on. Call this once before your first command here — it is the difference between writing for this machine and guessing.",
        input: NO_ARGS,
        run: async (_args, scopes) => textResult(await describeText(scopes)),
    }),
    tool({
        name: "run_command",
        description:
            "Run a command on this computer and get back its exit code, stdout and stderr. The shell is PowerShell on Windows and the user's login shell elsewhere (see describe). There is no terminal for anyone to type into: a command that prompts will fail rather than wait. Prefer one script that does the whole job over many small calls — every call is a network round trip to somebody's laptop.",
        input: z.object({
            command: required.describe("The command line to run, in this machine's shell."),
            cwd: required.optional().describe("Working directory. Must be inside the allowed folders. Defaults to the first allowed folder."),
            timeoutMs: z
                .int()
                .positive()
                .max(MAX_TIMEOUT_MS)
                .default(DEFAULT_TIMEOUT_MS)
                .describe(`How long to wait before killing it. Default ${DEFAULT_TIMEOUT_MS}, maximum ${MAX_TIMEOUT_MS}.`),
        }),
        run: async ({ command, cwd, timeoutMs }, scopes) => {
            const result = await runCommand({ command, ...(cwd === undefined ? {} : { cwd }), timeoutMs }, scopes);
            // A non-zero exit is a real answer, not a tool failure, the model reads the code and the streams and
            // decides. Only a command that could not be RUN comes back as an error.
            return textResult(describeResult(result, timeoutMs));
        },
    }),
    tool({
        name: "read_file",
        description: "Read a text file on this computer. Bounded by the folders this machine allows.",
        input: z.object({ path: required }),
        run: async ({ path }, scopes) => textResult(await readTextFile(path, scopes)),
    }),
    tool({
        name: "write_file",
        description:
            "Create a file or replace its contents. Requires the 'Create and change files' permission, which is OFF unless the user turned it on. Overwrites whole — read first if you mean to edit.",
        input: z.object({ path: required, content: z.string() }),
        run: async ({ path, content }, scopes) => textResult(await writeTextFile(path, content, scopes)),
    }),
    tool({
        name: "list_dir",
        description: "List a directory, with each entry's kind, size and modification time.",
        input: z.object({ path: required }),
        run: async ({ path }, scopes) => textResult(JSON.stringify(await listDirectory(path, scopes), undefined, 2)),
    }),
    tool({
        name: "trash_file",
        description:
            "Move a file into this agent's trash folder, from which the user can restore it. There is deliberately no permanent-delete tool. Requires the 'Create and change files' permission.",
        input: z.object({ path: required }),
        run: async ({ path }, scopes) => textResult(await trashFile(path, scopes)),
    }),
    tool({
        name: "list_windows",
        description:
            "Every window open on this computer: its app, title, size, position, and which one has focus. Call this before any GUI work — it is how you find the application you were asked about, and how you know where your typing will land. Requires the 'See the screen' permission.",
        input: NO_ARGS,
        run: async (_args, scopes) => textResult(await listWindows(desktop(), scopes)),
    }),
    tool({
        name: "focus_window",
        description:
            "Bring a window to the front and give it the keyboard, by the id from list_windows. ALWAYS do this before typing: text goes to whatever window has focus, not to where the pointer is. Requires the 'Use the mouse and keyboard' permission.",
        input: z.object({ id: required }),
        run: async ({ id }, scopes) => textResult(await focusWindow(desktop(), id, scopes)),
    }),
    tool({
        name: "open",
        description:
            "Start an application, or open a URL or file with whatever this computer has registered for it — the usual first step of a task ('open the browser at this page'). Use this rather than working out the platform's own incantation. Requires the 'Run commands' permission.",
        input: z.object({ target: required.describe("An application name, a file path, or a URL.") }),
        run: async ({ target }, scopes) => textResult(await openTarget(desktop(), target, scopes)),
    }),
    tool({
        name: "clipboard",
        description:
            "Read or replace this computer's clipboard — the reliable way to move text between applications, and often easier than reading it off a screenshot. Reading needs 'See the screen'; writing needs 'Use the mouse and keyboard'.",
        /* `text` is required BY the write and meaningless to the read, which is a pairing rather than a shape,
         * so it rides as a rule on the object instead of splitting the tool into two schemas. A union would say
         * it more precisely and publish `anyOf` at the root, which is not the `type: "object"` an MCP client
         * expects an inputSchema to be. */
        input: z
            .object({
                action: z.enum(["read", "write"]),
                text: z.string().min(1).optional().describe("The text to put on the clipboard (write)."),
            })
            .refine((args) => args.action !== "write" || args.text !== undefined, {
                error: `"text" is what a write puts on the clipboard — a write without it would clear it, which read/write cannot express.`,
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
            "Open a page in a browser on this computer and answer with what is on it: the page's title, its URL, and every element you can click or type into, each with a reference like [e12]. THIS IS THE RIGHT WAY TO USE A WEBSITE — act on elements by reference, never by clicking pixels, because references survive scrolling, resizing and re-rendering. The browser is a separate instance with its own profile, so the user's own tabs and session are untouched; the first time it opens they may need to sign in. Requires the 'Run commands' permission.",
        input: z.object({ url: required.describe("The page to open. A bare host like example.com is fine.") }),
        run: async ({ url }, scopes) => textResult(await openPage(web(), url, scopes)),
    }),
    tool({
        name: "browser_snapshot",
        description:
            "What the current page shows right now, with fresh [e…] references. Take one after anything that might have changed the page — references from an older snapshot are refused rather than clicking the wrong thing. Requires the 'See the screen' permission.",
        input: NO_ARGS,
        run: async (_args, scopes) => textResult(await snapshotPage(web(), scopes)),
    }),
    tool({
        name: "browser_read",
        description:
            "The current page as readable text — what a person would get by selecting all of it. Use this to ANSWER QUESTIONS about a page; use browser_snapshot when you intend to act on it. Requires the 'See the screen' permission.",
        input: NO_ARGS,
        run: async (_args, scopes) => textResult(await readPage(web(), scopes)),
    }),
    tool({
        name: "browser_click",
        description:
            "Click an element by its [e…] reference from the last snapshot. Answers with the page as it stands afterwards, so you see the result without asking. Requires the 'Use the mouse and keyboard' permission.",
        input: z.object({ ref: required }),
        run: async ({ ref }, scopes) => textResult(await clickElement(web(), ref, scopes)),
    }),
    tool({
        name: "browser_fill",
        description:
            "Type into a field by its [e…] reference — replaces what is there, and fires the events a page's own JavaScript listens for (setting a value without them is how a filled form submits empty). Set submit to press Enter afterwards. Requires the 'Use the mouse and keyboard' permission.",
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
            'Press a key on the page as a whole — "Return", "Escape", "Tab". For typing into a field use browser_fill. Requires the \'Use the mouse and keyboard\' permission.',
        input: z.object({ key: required }),
        run: async ({ key }, scopes) => textResult(await pressKey(web(), key, scopes)),
    }),
    tool({
        name: "browser_tabs",
        description:
            "Every tab open in that browser, and which one these tools are acting on. Pass an id to `select` to switch. Reading the list needs 'See the screen'; switching needs 'Use the mouse and keyboard'.",
        input: z.object({ select: required.optional().describe("The id of the tab to switch to. Omit to just list them.") }),
        run: async ({ select }, scopes) => textResult(select === undefined ? await listTabs(web(), scopes) : await selectTab(web(), select, scopes)),
    }),
    tool({
        name: "computer",
        description:
            "Use this computer's mouse and keyboard: click what is on the screen, type into the focused window, press a key combination, scroll, drag. Coordinates are PIXELS IN THE LAST SCREENSHOT — take one first and read them off it. Every action answers with a fresh screenshot so you can see what happened. Requires the 'Use the mouse and keyboard' permission, which is OFF unless the user turned it on. Prefer a command over the GUI when both would work: a command is exact, and a click is a guess about where something is.",
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
            coordinate: point.optional().describe("[x, y] in screenshot pixels — required for every pointer action."),
            to: point.optional().describe("[x, y] the drag ends at (left_click_drag)."),
            text: z.string().optional().describe('The text to type, or the key combination to press: "Return", "ctrl+c", "alt+Tab", "super+e".'),
            direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction. Default down."),
            amount: z.number().optional().describe("Wheel notches to scroll. Default 3."),
            ms: z.number().optional().describe('How long to wait (action "wait"). Default 400, maximum 10000.'),
        }),
        // Which coordinate an action NEEDS, and whether it is on the screen, is act()'s to answer, it is the only
        // caller that knows how big the screen is.
        run: async (input, scopes) => {
            await act(desktop(), input, scopes);
            // The confirming frame is the point of a GUI tool: without it the agent is typing blind and has to
            // ask for a screenshot after every action. It needs the `screen` grant too, so a machine that may be
            // driven but not watched gets the sentence instead, which is a coherent setting, not an error.
            if (scopes.screen !== "on") {
                return textResult(`${describeAction(input)} (No screenshot: "See the screen" is off for this computer.)`);
            }
            await settle();
            const shot = await screenshotResult(scopes);
            return { content: [{ type: "text", text: describeAction(input) }, ...(shot["content"] as unknown[])], isError: false };
        },
    }),
    tool({
        name: "screenshot",
        description:
            "Capture what is on this computer's screen right now, as an image. Use it to read a dialog, check on a window, or see what the user is describing. Requires the 'See the screen' permission.",
        input: NO_ARGS,
        run: async (_args, scopes) => await screenshotResult(scopes),
    }),
    tool({
        name: "list_sandboxes",
        description:
            "The Intentic sandboxes on this computer, as JSON — each one's slug, whether it is running, and whether its tunnel is up. Only sandbox containers; nothing else on the machine is listed. Requires 'Run commands' or 'Manage sandboxes on this computer'.",
        input: NO_ARGS,
        run: async (_args, scopes) => textResult(await listSandboxes(scopes)),
    }),
    tool({
        name: "manage_sandbox",
        description:
            "Start, stop or restart one Intentic sandbox on this computer, by its slug from list_sandboxes. Stopping one interrupts whoever is working in it — and stopping the sandbox you are calling from severs your own connection. Requires the 'Manage sandboxes on this computer' permission, which is OFF unless the user turned it on.",
        input: z.object({ op: SandboxOpSchema, slug: required.describe("The sandbox's slug, from list_sandboxes.") }),
        run: async ({ op, slug }, scopes) => textResult(await manageSandbox(op, slug, scopes)),
    }),
    /* The three flows that run `ic`. As an MCP call they answer once, at the end, with everything the flow
     * printed, a model has nothing to do with a line as it arrives. The BROWSER does, which is why the same
     * functions take a line callback and the streaming route (host.contract's `runSandboxFlow`) passes one
     * that forwards each line as it happens. One implementation, two ways of watching it. */
    tool({
        name: "swap_sandbox",
        description:
            "Move one Intentic sandbox on this computer onto a different image: 'update' pulls the newest image of its release channel, 'rollback' returns it to the image it ran before its last update, and 'rebuild' rebuilds the owner-approved environment overlay. Files (/work) and history are kept in all three. Takes MINUTES — it pulls an image and recreates the container, and the sandbox is down while it happens. 'prepare' is the exception and the one to reach for first: it does the downloading and building of the next update WITHOUT touching the container, so the sandbox keeps running throughout and the 'update' that follows is a restart of seconds instead of a wait of minutes. Requires the 'Manage sandboxes on this computer' permission.",
        input: z.object({
            op: SandboxSwapSchema,
            slug: required.describe("The sandbox's slug, from list_sandboxes."),
            hash: required.optional().describe("sha256 of the approved overlay — required for 'rebuild', ignored otherwise."),
        }),
        run: async ({ op, slug, hash }, scopes) => textResult(await swapSandbox(op, slug, hash, scopes, () => {})),
    }),
    tool({
        name: "remove_sandbox",
        description:
            "Delete one Intentic sandbox from this computer: its container, its network, and the volumes holding its files and its history. THIS CANNOT BE UNDONE and is not what stopping it does — confirm with the user before calling it. Requires the 'Remove sandboxes from this computer' permission, which is separate from managing them and OFF unless the user turned it on.",
        input: z.object({ slug: required.describe("The sandbox's slug, from list_sandboxes.") }),
        run: async ({ slug }, scopes) => textResult(await removeSandbox(slug, scopes, () => {})),
    }),
    tool({
        name: "sandbox_logs",
        description:
            "The tail of one Intentic sandbox's container log on this computer — how you find out why it will not start or what it did before it stopped. Requires 'Run commands' or 'Manage sandboxes on this computer'.",
        input: z.object({
            slug: required.describe("The sandbox's slug, from list_sandboxes."),
            // The prose and the rule come off the same two numbers, so the sentence the model reads cannot
            // promise a ceiling other than the one it will be held to.
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

const BY_NAME = new Map(TOOLS.map((entry) => [entry.name, entry]));

/* What the audit log records about a call. Arguments verbatim, EXCEPT typed text: `computer` with action "type"
 * carries whatever the user asked to be entered, which is routinely a password or a message, and writing it to a
 * file on their disk is the one thing an audit trail must not do to earn its place. Its LENGTH still tells the
 * story a reader needs, "typed 24 characters into the focused window", without becoming a second copy of the
 * secret. A key combination is not redacted: "ctrl+c" is the fact, and there is nothing in it to leak. */
const auditDetail = (name: string, args: Record<string, unknown>): string => {
    const redact =
        (name === "computer" && args["action"] === "type") || (name === "clipboard" && args["action"] === "write") || name === "browser_fill";
    const safe = redact ? { ...args, text: `<${String(args["text"] ?? "").length} characters>` } : args;
    return JSON.stringify(safe).slice(0, 500);
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Handle one JSON-RPC message. Returns the response, or undefined for a notification (nothing to answer).
// `scopes` is read per call from the live grant, so a scopes frame that arrives mid-session takes effect on the
// very next tool call rather than at the next reconnect.
export const handleMcpMessage = async (message: unknown, scopes: () => HostScopes): Promise<Record<string, unknown> | undefined> => {
    if (!isRecord(message)) {
        return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
    }
    const id = message["id"];
    const method = message["method"];
    if (id === undefined) {
        return undefined;
    }
    const reply = (result: Record<string, unknown>): Record<string, unknown> => ({ jsonrpc: "2.0", id, result });

    if (method === "initialize") {
        return reply({
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "intentic-host", version: HOST_VERSION },
        });
    }
    if (method === "ping") {
        return reply({});
    }
    if (method === "tools/list") {
        return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    }
    if (method === "tools/call") {
        const params = isRecord(message["params"]) ? message["params"] : {};
        const name = typeof params["name"] === "string" ? params["name"] : "";
        const args = isRecord(params["arguments"]) ? params["arguments"] : {};
        const found = BY_NAME.get(name);
        if (found === undefined) {
            return reply(textResult(`This computer has no tool called "${name}".`, true));
        }
        try {
            const result = await found.call(args, scopes());
            void audit({ tool: name, ok: result["isError"] !== true, detail: auditDetail(name, args) });
            return reply(result);
        } catch (error) {
            const refused = error instanceof ScopeError;
            void audit({
                tool: name,
                ok: false,
                detail: `${refused ? "refused" : "failed"}: ${error instanceof Error ? error.message : String(error)}`,
            });
            return reply(textResult(error instanceof Error ? error.message : String(error), true));
        }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `method "${String(method)}" is not supported` } };
};
