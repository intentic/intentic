import { z } from "zod";
import { errorMessage } from "@intentic/base/errors";
import type { ExtensionServerApi, ToolArguments, ToolCallContext, ToolDefinition, ToolEffect, ToolGrantAccount, ToolResult } from "@intentic/extension-api";
import { KitRefusal } from "./kit/index.js";
import {
    CHAT_TIMING,
    CHATGPT_IMAGE_FIELDS,
    CHATGPT_READ_FIELDS,
    CHATGPT_SEND_FIELDS,
    CHATGPT_TOOL_EFFECTS,
    CHATGPT_TOOL_NAMES,
    type ChatgptHost,
    type ChatTiming,
    chatgptImage,
    chatgptRead,
    chatgptSend,
    chatgptToolDescriptions,
} from "./kit/chatgpt/index.js";
import { IMAGES_AT_ONCE, inOwnerBrowser, ownerImage } from "./owner.js";
import { sandboxChatgptHost, sandboxVoice, tabHold } from "./sandbox/account-host.js";
import type { ShelfFile } from "./sandbox/shelf.js";
import { whereOf } from "./where.js";

// THE THREE TOOLS (2026-11-26, from the daemon's `browser` router and its owner's-browser door): chatgpt_send,
// chatgpt_read and chatgpt_image on this extension's own server (`mcp__chatgpt__…`), under the names and with the
// arguments the agent knew, plus where each runs: `account` (a sandbox account's signed-in browser, which the `browser`
// router's tools took too) or `browser` (the person's own, where the same three were that browser's own tools).

export type KitApi = Pick<ExtensionServerApi, "browser" | "ownerBrowser" | "jobs" | "document" | "workspaceRoot" | "log">;

export interface KitDeps {
    readonly api: KitApi;
    readonly sandboxName: () => Promise<string>;
    // The kit's waits; absent is its own (CHAT_TIMING), tests shorten them.
    readonly timing?: ChatTiming;
    // How long chatgpt_image in the person's browser waits before it answers with its job; tests shorten it.
    readonly quickMs?: number;
}

const where = {
    account: z
        .string()
        .min(1)
        .optional()
        .describe(
            "A sandbox account signed in on chatgpt.com (`mcp__accounts__roster` names them), whose own browser here runs the call. Left out: the one such account this turn holds.",
        ),
    browser: z
        .string()
        .min(1)
        .optional()
        .describe(
            'Instead of `account`: one of the person\'s own connected browsers (its name, e.g. "chrome"), to use their own ChatGPT there. Only when they asked for it, or ChatGPT needs something only that browser has.',
        ),
};

const SendSchema = z.object({ ...CHATGPT_SEND_FIELDS, ...where });
const ReadSchema = z.object({ ...CHATGPT_READ_FIELDS, ...where });
const ImageSchema = z.object({ ...CHATGPT_IMAGE_FIELDS, ...where });

const IN_THEIR_BROWSER =
    "With `browser`, it runs in the person's own browser instead, where chatgpt.com must be allowed in read and act and the person is asked before any file goes.";
const IMAGE_IN_THEIR_BROWSER =
    `With \`browser\` (the person's own browser, chatgpt.com allowed in read and act) the call does not wait: it answers within seconds with a job id while ChatGPT works on in a tab of that browser. Collect it with the \`wait\` tool on the \`subagents\` server (mcp__subagents__wait), target the job id, or end your turn: the job's end wakes this conversation. ${IMAGES_AT_ONCE} run at once per browser and the rest queue; for a series in one look, wait for the first and pass its \`chat\` to the next. ` +
    "In a sandbox account's browser the call holds until the image is made, one at a time.";

const text = (words: string, isError = false): ToolResult => (isError ? { content: [{ type: "text", text: words }], isError: true } : { content: [{ type: "text", text: words }] });

// An input schema as tools/list shows it: what the agent may send, defaults optional.
const listed = (schema: z.ZodType): ToolDefinition["inputSchema"] => {
    const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(schema, { io: "input" });
    return inputSchema;
};

// The arguments the agent sent, less where they run: what the person's browser's own tool takes.
const withoutWhere = (args: ToolArguments): ToolArguments => Object.fromEntries(Object.entries(args).filter(([key]) => key !== "account" && key !== "browser"));

// One kit call in a sandbox account's browser, its tab held for the call; a refusal answers as its words.
const inSandbox = async (deps: KitDeps, context: ToolCallContext, account: ToolGrantAccount, holders: Map<string, symbol>, run: (host: ChatgptHost<ShelfFile>, timing: ChatTiming) => Promise<string>): Promise<ToolResult> => {
    const timing = deps.timing ?? CHAT_TIMING;
    const tab = tabHold(holders, account.id);
    const host = sandboxChatgptHost({ api: deps.api, standing: context, account, sandboxName: deps.sandboxName, tab, stepMs: timing.stepMs });
    try {
        return text(await run(host, timing));
    } catch (error) {
        return text(error instanceof KitRefusal ? error.message : `The ChatGPT kit failed: ${errorMessage(error)}`, true);
    } finally {
        tab.release();
    }
};

// A tool whose arguments are parsed, and whose call goes where they say: a sandbox account's browser, or the person's.
const kitTool = <Schema extends z.ZodType<{ readonly account?: string | undefined; readonly browser?: string | undefined }>>(spec: {
    readonly name: string;
    readonly description: string;
    readonly effect: ToolEffect;
    readonly schema: Schema;
    readonly inSandbox: (args: z.output<Schema>, context: ToolCallContext, account: ToolGrantAccount) => Promise<ToolResult>;
    readonly inBrowser: (args: z.output<Schema>, context: ToolCallContext, browser: string, sent: ToolArguments) => Promise<ToolResult>;
}): ToolDefinition => ({
    name: spec.name,
    description: spec.description,
    inputSchema: listed(spec.schema),
    effect: spec.effect,
    call: async (args, context) => {
        const parsed = spec.schema.safeParse(args);
        if (!parsed.success) {
            return text(z.prettifyError(parsed.error), true);
        }
        const at = whereOf(context.grants, parsed.data);
        if (at.kind === "refused") {
            return text(at.refusal, true);
        }
        try {
            return at.kind === "account" ? await spec.inSandbox(parsed.data, context, at.account) : await spec.inBrowser(parsed.data, context, at.browser, withoutWhere(args));
        } catch (error) {
            return text(`The ChatGPT kit failed: ${errorMessage(error)}`, true);
        }
    },
});

/** The kit's three tools, served on this extension's own MCP server. */
export const chatgptTools = (deps: KitDeps): ToolDefinition[] => {
    const described = chatgptToolDescriptions(sandboxVoice(undefined));
    // One kit call at a time per account: they share its one tab.
    const holders = new Map<string, symbol>();
    return [
        kitTool({
            name: CHATGPT_TOOL_NAMES.send,
            description: `${described.send} ${IN_THEIR_BROWSER}`,
            effect: CHATGPT_TOOL_EFFECTS.send,
            schema: SendSchema,
            inSandbox: async ({ prompt, chat, mode, files, wait, name, personalized, temporary }, context, account) =>
                await inSandbox(deps, context, account, holders, async (host, timing) => await chatgptSend(host, { prompt, chat, mode, files, waitSeconds: wait, name, personalized, temporary }, timing)),
            inBrowser: async (_args, context, browser, sent) => await inOwnerBrowser(deps.api, context, browser, CHATGPT_TOOL_NAMES.send, sent),
        }),
        kitTool({
            name: CHATGPT_TOOL_NAMES.read,
            description: `${described.read} ${IN_THEIR_BROWSER}`,
            effect: CHATGPT_TOOL_EFFECTS.read,
            schema: ReadSchema,
            inSandbox: async ({ chat, wait, name }, context, account) =>
                await inSandbox(deps, context, account, holders, async (host, timing) => await chatgptRead(host, { chat, waitSeconds: wait, name }, timing)),
            inBrowser: async (_args, context, browser, sent) => await inOwnerBrowser(deps.api, context, browser, CHATGPT_TOOL_NAMES.read, sent),
        }),
        kitTool({
            name: CHATGPT_TOOL_NAMES.image,
            description: `${described.image} ${IMAGE_IN_THEIR_BROWSER}`,
            effect: CHATGPT_TOOL_EFFECTS.image,
            schema: ImageSchema,
            inSandbox: async ({ prompt, chat, name, personalized, temporary }, context, account) =>
                await inSandbox(deps, context, account, holders, async (host, timing) => await chatgptImage(host, { prompt, chat, name, personalized, temporary }, timing)),
            inBrowser: async ({ prompt, chat }, context, browser, sent) => await ownerImage(deps.api, context, browser, { prompt, chat, args: sent }, deps.quickMs),
        }),
    ];
};
