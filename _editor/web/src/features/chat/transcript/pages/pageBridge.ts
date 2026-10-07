import { PAGE_BRIDGE, PAGE_ERROR_CHARS, PAGE_VALUE_MAX, type PageTheme, pageValueText } from "@intentic/sandbox-contract";
import { PreviewAskSchema } from "../../../workspace/viewers/html/htmlDocument";

// What a page in the chat may say to the window around it, read where it arrives: the page's own scripts can post
// anything, so every message is parsed here into one of a few asks, and anything else is nothing. Two dialects arrive.
// The sealed document's own link guide (htmlDocument.ts) asks to open a workspace file or an address; the page's half of
// the bridge (sandbox-contract text/pages.ts) speaks the MCP Apps extension's JSON-RPC. Which of the asks the chat acts
// on, and when, is ChatPageFrame's to decide: none of them is ever taken on the page's word alone.

export type PageAsk =
    // How tall the page is now, for the frame to fit it.
    | { readonly kind: "size"; readonly height: number }
    // The page's half of the handshake, answered with the theme it should wear.
    | { readonly kind: "initialize"; readonly id: string | number }
    // An address to open in a tab of its own.
    | { readonly kind: "openLink"; readonly id: string | number | undefined; readonly url: string }
    // A workspace file a link in the page names.
    | { readonly kind: "openFile"; readonly path: string }
    // Words for the chat's composer, which the person then sends (or not).
    | { readonly kind: "message"; readonly id: string | number; readonly text: string }
    // An uncaught error in the page's own scripts, for the agent that showed it and the reader's line under it.
    | { readonly kind: "error"; readonly message: string }
    // An `ask_page` page's answer, as JSON text, or a refusal when it is too large to be one.
    | { readonly kind: "submit"; readonly id: string | number; readonly value: string }
    | { readonly kind: "oversize"; readonly id: string | number }
    // An MCP server's app: ready for its call's input and result, asking its server for a tool, or asking for what this
    // host keeps for itself (the model's context, another display mode), which it is answered without.
    | { readonly kind: "initialized" }
    | { readonly kind: "toolCall"; readonly id: string | number; readonly name: string; readonly arguments: Record<string, unknown> }
    | { readonly kind: "acknowledge"; readonly id: string | number; readonly result: Record<string, unknown> };

type RequestId = string | number;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === `object` && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is RequestId => typeof value === `string` || (typeof value === `number` && Number.isFinite(value));

// The words of an MCP `ui/message`: its text parts, joined.
const messageText = (params: Record<string, unknown>): string | undefined => {
    const content = params[`content`];
    const parts = Array.isArray(content) ? content : [content];
    const words = parts
        .filter(isRecord)
        .flatMap((part) => (part[`type`] === `text` && typeof part[`text`] === `string` ? [part[`text`]] : []))
        .join(`\n`)
        .trim();
    return words === `` ? undefined : words;
};

const httpUrl = (value: unknown): string | undefined => (typeof value === `string` && /^https?:\/\//i.test(value) ? value : undefined);

// One message, as the ask it is, or undefined for anything that is not one.
export const readPageAsk = (data: unknown): PageAsk | undefined => {
    const preview = PreviewAskSchema.safeParse(data);
    if (preview.success) {
        const ask = preview.data.intenticHtmlPreview;
        if (`open` in ask) {
            return { kind: `openFile`, path: ask.open };
        }
        return `href` in ask ? { kind: `openLink`, id: undefined, url: ask.href } : undefined;
    }
    if (!isRecord(data) || data[`jsonrpc`] !== `2.0` || typeof data[`method`] !== `string`) {
        return undefined;
    }
    const params = isRecord(data[`params`]) ? data[`params`] : {};
    const id = data[`id`];
    switch (data[`method`]) {
        case PAGE_BRIDGE.sizeChanged: {
            const height = params[`height`];
            return typeof height === `number` && Number.isFinite(height) && height > 0 ? { kind: `size`, height } : undefined;
        }
        case PAGE_BRIDGE.initialize:
            return isId(id) ? { kind: `initialize`, id } : undefined;
        case PAGE_BRIDGE.openLink: {
            const url = httpUrl(params[`url`]);
            return url === undefined ? undefined : { kind: `openLink`, id: isId(id) ? id : undefined, url };
        }
        case PAGE_BRIDGE.message: {
            const text = messageText(params);
            return isId(id) && text !== undefined ? { kind: `message`, id, text } : undefined;
        }
        case PAGE_BRIDGE.initialized:
            return { kind: `initialized` };
        case PAGE_BRIDGE.error: {
            const message = params[`message`];
            return typeof message === `string` && message.trim() !== `` ? { kind: `error`, message: message.trim().slice(0, PAGE_ERROR_CHARS) } : undefined;
        }
        case PAGE_BRIDGE.toolsCall: {
            const name = params[`name`];
            const args = params[`arguments`];
            return isId(id) && typeof name === `string` && name !== ``
                ? { kind: `toolCall`, id, name, arguments: isRecord(args) ? args : {} }
                : undefined;
        }
        // Taken without effect: the chat does not hand an app's notes to the model, and a page stays inline.
        case PAGE_BRIDGE.updateModelContext:
            return isId(id) ? { kind: `acknowledge`, id, result: {} } : undefined;
        case PAGE_BRIDGE.requestDisplayMode:
            return isId(id) ? { kind: `acknowledge`, id, result: { mode: `inline` } } : undefined;
        case PAGE_BRIDGE.submit: {
            if (!isId(id)) {
                return undefined;
            }
            const value = pageValueText(params[`value`]);
            return value.length > PAGE_VALUE_MAX ? { kind: `oversize`, id } : { kind: `submit`, id, value };
        }
        default:
            return undefined;
    }
};

// What the window answers a request with: done, or why not, in words the page's own script can show.
export const pageResult = (id: RequestId, result: Record<string, unknown> = {}) => ({ jsonrpc: `2.0`, id, result }) as const;
export const pageRefusal = (id: RequestId, message: string) => ({ jsonrpc: `2.0`, id, error: { code: -32000, message } }) as const;

// The theme as the bridge says it, in the MCP Apps extension's own words.
export const hostContextOf = (theme: PageTheme) => ({ theme: theme.appearance, styles: { variables: { ...theme.variables } }, displayMode: `inline` });

export const themeMessage = (theme: PageTheme) => ({ jsonrpc: `2.0`, method: PAGE_BRIDGE.hostContextChanged, params: hostContextOf(theme) }) as const;

// The handshake's answer: who the host is, what it will do for a page, and the context it is in; for an MCP server's app,
// which tool's call it shows, and that it may call its server's tools.
export const initializeResult = (theme: PageTheme, tool?: string) => ({
    protocolVersion: `2026-01-26`,
    hostInfo: { name: `intentic`, version: `1` },
    hostCapabilities: { openLinks: {}, message: {}, ...(tool === undefined ? {} : { serverTools: {} }) },
    hostContext: { ...hostContextOf(theme), availableDisplayModes: [`inline`], ...(tool === undefined ? {} : { toolInfo: { tool: { name: tool } } }) },
});

// What an app is handed once it is ready: its call's arguments, then its result.
export const toolInputMessage = (input: unknown) => ({ jsonrpc: `2.0`, method: PAGE_BRIDGE.toolInput, params: { arguments: input ?? {} } }) as const;
export const toolResultMessage = (result: unknown) => ({ jsonrpc: `2.0`, method: PAGE_BRIDGE.toolResult, params: result ?? {} }) as const;
