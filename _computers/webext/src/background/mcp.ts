import { MCP_PROTOCOL_VERSION } from "@intentic/sandbox-contract";
import { z } from "zod";
import { record } from "./audit.js";
import { RefusedError } from "./policy.js";
import { askAccess, describeAccess } from "./tools/access.js";
import { click, fill, openUrl, pressKey, readable, screenshot, scroll, selectOption, snapshot, waitFor } from "./tools/page.js";
import { connectSite } from "./tools/session.js";
import { listTabs, selectTab } from "./tools/tabs.js";

/* THE MCP SERVER, running HERE, in the browser — not in the sandbox.
 *
 * The daemon forwards JSON-RPC verbatim and interprets none of it (bar one envelope on the way back), so this
 * file is the entire tool surface: what a connected browser can do is decided by the extension installed in
 * it, and an extension that updates learns new tools without anything changing in the sandbox. Which matters
 * more here than it does for a connected computer: this artifact ships through a store review, on its own
 * schedule, and a tool surface pinned to a daemon release would mean waiting for both.
 *
 * A FAILED TOOL IS NOT A FAILED CALL. A refused site, a stale ref, a person clicking No — all of it comes back
 * as an ordinary result with isError, because that is what a model can read and act on. A JSON-RPC error
 * surfaces as a transport fault and invites a retry loop against a browser that will refuse identically.
 *
 * EACH TOOL'S ARGUMENTS ARE DESCRIBED ONCE: the zod schema below is what the model is shown (`tools/list`
 * publishes it as JSON Schema) AND what an arriving call is checked against, so the advertised shape and the
 * accepted one cannot drift. */

interface Tool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    readonly call: (args: unknown) => Promise<Record<string, unknown>>;
}

const textResult = (text: string, isError = false): Record<string, unknown> => ({ content: [{ type: "text", text }], isError });

const tool = <Schema extends z.ZodType>(spec: {
    name: string;
    description: string;
    input: Schema;
    run: (args: z.output<Schema>) => Promise<Record<string, unknown>>;
}): Tool => {
    const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(spec.input, { io: "input" });
    return {
        name: spec.name,
        description: spec.description,
        inputSchema,
        call: async (args) => {
            const parsed = spec.input.safeParse(args);
            return parsed.success ? await spec.run(parsed.data) : textResult(z.prettifyError(parsed.error), true);
        },
    };
};

const NO_ARGS = z.object({});
const required = z.string().min(1);
// Which tab to work in. Absent = the one in front, which is what a person means by "the page". An id comes
// from `tabs`, and naming one is how the agent works somewhere that is not in front.
const tab = z.number().int().optional().describe("Which tab, from `tabs`. Omit for the tab in front.");

const TOOLS: readonly Tool[] = [
    tool({
        name: "describe",
        description:
            "Which browser this is, how many tabs are open, and — the part you need before anything else — exactly which sites you are allowed to work on and whether each is read-only. Call this first.",
        input: NO_ARGS,
        run: async () => textResult(await describeAccess()),
    }),
    tool({
        name: "tabs",
        description:
            "Every tab open in this browser, with the one in front marked. Sites you have not been allowed on are listed without their address, which is the person's privacy rather than a fault. Pass `select` to bring a tab to the front.",
        input: z.object({ select: z.number().int().optional().describe("A tab id to switch to. Omit to just list them.") }),
        run: async ({ select }) => textResult(select === undefined ? await listTabs() : await selectTab(select)),
    }),
    tool({
        name: "open",
        description:
            "Point a tab at a URL and answer with the page. Anyone may open a tab; READING what lands there needs the site to be allowed, and the answer says so plainly when it is not.",
        input: z.object({
            url: required.describe("The page to open. A bare host like example.com is fine."),
            tab: z.enum(["current", "new"]).default("current").describe("Reuse the tab in front, or open a new one."),
        }),
        run: async ({ url, tab: where }) => textResult(await openUrl(url, where)),
    }),
    tool({
        name: "snapshot",
        description:
            "What the page shows right now: every element you can click or type into, each with a reference like [e12]. Take one before acting. References die with the page — one from an older snapshot is refused rather than clicking whatever now sits in that slot.",
        input: z.object({ tab }),
        run: async ({ tab: id }) => textResult(await snapshot(id)),
    }),
    tool({
        name: "read",
        description:
            "The page as readable text — what a person would get by selecting all of it. Use this to ANSWER questions about a page; use snapshot when you intend to act on it.",
        input: z.object({ tab }),
        run: async ({ tab: id }) => textResult(await readable(id)),
    }),
    tool({
        name: "click",
        description:
            "Click an element by its [e…] reference. Answers with the page as it stands afterwards. On a page that deals in passwords, money or deletion, the person is asked in their own browser first.",
        input: z.object({ ref: required, tab }),
        run: async ({ ref, tab: id }) => textResult(await click(ref, id)),
    }),
    tool({
        name: "fill",
        description:
            "Type into a field by its [e…] reference: replaces what is there, and fires the events the page's own JavaScript listens for (setting a value without them is how a filled form submits empty). `submit` presses Enter afterwards, which is the half that gets confirmed.",
        input: z.object({
            ref: required,
            text: z.string(),
            submit: z.boolean().default(false).describe("Submit the form after typing. Default false."),
            tab,
        }),
        run: async ({ ref, text, submit, tab: id }) => textResult(await fill(ref, text, submit, id)),
    }),
    tool({
        name: "select_option",
        description: "Choose in a dropdown by its [e…] reference. Values match either the option's value or the label you can see in the snapshot.",
        input: z.object({ ref: required, values: z.array(required).min(1), tab }),
        run: async ({ ref, values, tab: id }) => textResult(await selectOption(ref, values, id)),
    }),
    tool({
        name: "key",
        description: 'Press a key for the page as a whole: "Enter", "Escape", "PageDown". For typing into a field use fill.',
        input: z.object({ key: required, tab }),
        run: async ({ key, tab: id }) => textResult(await pressKey(key, id)),
    }),
    tool({
        name: "scroll",
        description: "Scroll the page, when what you need has not been rendered into the snapshot yet. Counts as reading, not acting.",
        input: z.object({
            direction: z.enum(["up", "down", "left", "right"]).default("down"),
            amount: z.number().int().min(1).max(10).default(1).describe("Roughly this many screens."),
            tab,
        }),
        run: async ({ direction, amount, tab: id }) => textResult(await scroll(direction, amount, id)),
    }),
    tool({
        name: "wait_for",
        description:
            "Wait for text to appear (or disappear) on the page, instead of guessing at a delay. This is what to use after a submit: wait for the thing you expect rather than snapshotting into a spinner.",
        input: z
            .object({
                text: required.optional().describe("Wait until this appears."),
                textGone: required.optional().describe("Wait until this disappears."),
                seconds: z.number().int().min(1).max(60).default(15),
                tab,
            })
            .refine((args) => args.text !== undefined || args.textGone !== undefined, {
                error: `Say what to wait for: "text" for something to appear, "textGone" for something to disappear.`,
                path: ["text"],
            }),
        run: async ({ text, textGone, seconds, tab: id }) =>
            textResult(await waitFor({ ...(text === undefined ? {} : { text }), ...(textGone === undefined ? {} : { textGone }), seconds }, id)),
    }),
    tool({
        name: "screenshot",
        description:
            "The visible tab as an image. For canvas apps, maps and PDF viewers, where the page's own structure says nothing. Needs its own switch on this browser's card, which is off unless the owner turned it on.",
        input: NO_ARGS,
        run: async () => {
            const shot = await screenshot();
            return { content: [{ type: "image", data: shot.data, mimeType: shot.mimeType }], isError: false };
        },
    }),
    tool({
        name: "ask_access",
        description:
            "Ask the person to allow this browser's agent on a site. Their extension lights up with your reason; only they can grant it, because the browser refuses a permission that was not asked for by a person's own click. Call this and STOP — do not look for another way onto the site.",
        input: z.object({
            origin: required.describe(`The site, as a host or an origin: "github.com" or "https://github.com".`),
            reason: required.describe("Why you need it, in one plain sentence. They read this."),
        }),
        run: async ({ origin, reason }) => textResult(await askAccess(origin, reason)),
    }),
    tool({
        name: "connect_site",
        description:
            "Hand THIS site's signed-in session to the sandbox's own browser, so work can carry on after this browser is closed. Needs the owner's click in their browser every time, and a switch on this card. You never see what moved. Say plainly what it means before offering it: the sandbox will be signed in as them, and some sites end a session that starts appearing from a second place.",
        input: z.object({
            account: required.describe("An existing connected-browser account in the sandbox, the one this session should land in."),
            tab,
        }),
        run: async ({ account, tab: id }) => textResult(await connectSite(account, id)),
    }),
];

const BY_NAME = new Map(TOOLS.map((entry) => [entry.name, entry]));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Handle one JSON-RPC message. Returns the response, or undefined for a notification (nothing to answer).
export const handleMcpMessage = async (message: unknown, version: string): Promise<Record<string, unknown> | undefined> => {
    if (!isRecord(message)) {
        return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
    }
    const id = message["id"];
    if (id === undefined) {
        return undefined;
    }
    const method = message["method"];
    const reply = (result: Record<string, unknown>): Record<string, unknown> => ({ jsonrpc: "2.0", id, result });

    if (method === "initialize") {
        return reply({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "intentic-webext", version } });
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
            return reply(textResult(`This browser has no tool called "${name}".`, true));
        }
        try {
            const result = await found.call(args);
            await record(name, args, result["isError"] !== true);
            return reply(result);
        } catch (error) {
            const refused = error instanceof RefusedError;
            const said = error instanceof Error ? error.message : String(error);
            await record(name, args, false, `${refused ? "refused" : "failed"}: ${said}`);
            return reply(textResult(said, true));
        }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `method "${String(method)}" is not supported` } };
};
