import { isRecord } from "@intentic/base/escape";
import { PAGE_BRIDGE, PAGE_ERROR_CHARS, PAGE_PICTURES_MAX, type PageTheme, pageValueText } from "@intentic/sandbox-contract/text/pages";
import { PAGE_VALUE_MAX } from "@intentic/sandbox-contract/events/requests";
import { z } from "zod";
import { PreviewAskSchema } from "../../../../models/workspace/viewers/htmlDocument";

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
    // One of the page's own players failed to load its video or audio.
    | { readonly kind: "mediaError" }
    // An `ask_page` page's answer, as JSON text, or a refusal when it is too large to be one.
    | { readonly kind: "submit"; readonly id: string | number; readonly value: string }
    | { readonly kind: "oversize"; readonly id: string | number }
    // An MCP server's app: ready for its call's input and result, asking its server for a tool, or asking for what this
    // host keeps for itself (the model's context, another display mode), which it is answered without.
    | { readonly kind: "initialized" }
    | { readonly kind: "toolCall"; readonly id: string | number; readonly name: string; readonly arguments: Record<string, unknown> }
    | { readonly kind: "acknowledge"; readonly id: string | number; readonly result: Record<string, unknown> }
    // The pointer rests on one of the page's pictures drawn smaller than it is, or has left it (no picture).
    | { readonly kind: "pictureLook"; readonly picture: PagePictureLook | undefined }
    // A press on such a picture: every such picture on the page, in order, and which of them was pressed.
    | { readonly kind: "pictureOpen"; readonly pictures: readonly PagePicture[]; readonly index: number };

// One of a page's pictures, as the page carried it in: a picture's data, never an address, so showing it outside the
// page loads nothing and runs nothing.
export interface PagePicture {
    readonly src: string;
    readonly alt: string;
}

// The picture the pointer rests on, with where the page draws it (in the frame's own coordinates) and its own shape.
export interface PagePictureLook extends PagePicture {
    readonly rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
    readonly aspect: number;
}

type RequestId = string | number;

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

// A picture's data as an `<img>` in this window may show it; anything else (an address, a script) is no picture.
const ALT_CHARS = 200;
const PictureSchema = z.object({
    src: z.string().regex(/^data:image\/[\w.+-]+[;,]/i),
    alt: z
        .string()
        .catch(``)
        .transform((alt) => alt.trim().slice(0, ALT_CHARS)),
});
const PictureLookSchema = PictureSchema.extend({
    left: z.number().finite(),
    top: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
    aspect: z.number().finite().positive(),
}).transform(({ src, alt, left, top, width, height, aspect }): PagePictureLook => ({ src, alt, rect: { left, top, width, height }, aspect }));
// An entry that is no picture costs only itself, but the press has to be on one, and lands on it among the rest.
const PictureOpenSchema = z
    .object({
        pictures: z.array(PictureSchema.optional().catch(undefined)).max(PAGE_PICTURES_MAX),
        index: z.number().int().nonnegative(),
    })
    .refine(({ pictures, index }) => pictures[index] !== undefined)
    .transform(({ pictures, index }) => ({
        pictures: pictures.filter((picture) => picture !== undefined),
        index: pictures.slice(0, index).filter((picture) => picture !== undefined).length,
    }));

const httpUrl = (value: unknown): string | undefined => (typeof value === `string` && /^https?:\/\//i.test(value) ? value : undefined);

// Notices read whole by their schema: those that carry nothing but their name, the picture the pointer rests on (none
// once it leaves, or for one that is no picture), and a press on one.
const bare = (ask: PageAsk): z.ZodType<PageAsk> => z.unknown().transform(() => ask);
const NOTICES: ReadonlyMap<string, z.ZodType<PageAsk>> = new Map<string, z.ZodType<PageAsk>>([
    [PAGE_BRIDGE.initialized, bare({ kind: `initialized` })],
    [PAGE_BRIDGE.mediaError, bare({ kind: `mediaError` })],
    [PAGE_BRIDGE.pictureLook, z.unknown().transform((params): PageAsk => ({ kind: `pictureLook`, picture: PictureLookSchema.safeParse(params).data }))],
    [PAGE_BRIDGE.pictureOpen, PictureOpenSchema.transform((open): PageAsk => ({ kind: `pictureOpen`, ...open }))],
]);

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
            return NOTICES.get(data[`method`])?.safeParse(params).data;
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
