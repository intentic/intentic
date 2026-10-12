import { writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { Page } from "playwright";
import type { RpcMessage } from "../../agent/tools/turn-mounts.js";
import { sanitizeUrl } from "../tools/network-redaction.js";
import { BROWSER_OUTPUT_REL } from "./browser-artifacts.js";

// A screenshot's provenance, written beside it as `<file>.json`: which conversation took it, by which tool call, of
// which page, and how far that page had loaded. The output directory holds thousands of shots from every conversation
// and nothing said whose any of them was, or whether a blank one was of a page still loading.
//
// Written by the router (browser-router.ts), the one place every runtime's browser call passes, after the backend has
// answered. The page is read just after the shot, off the tab the session last saw a tool touch: a navigation in the
// same instant can describe the next page, which is why `at` is the read's own time.

// A page that does not answer an evaluate this quickly (a dialog up, a renderer busy) is described by what Playwright
// already knows of it.
const READ_TIMEOUT_MS = 1000;

export interface ScreenshotProvenance {
    readonly conversationId?: string;
    // The runtime's id for the call, when its MCP client sends one (Claude Code's `claudecode/toolUseId`).
    readonly toolCallId?: string;
    // The profile owner whose browser took it: `web`, or a connected account's.
    readonly browser: string;
    readonly url?: string;
    readonly readyState?: string;
    readonly viewport?: { readonly width: number; readonly height: number; readonly deviceScaleFactor: number };
    readonly at: string;
}

// @playwright/mcp answers with a markdown link to the file it wrote, relative to its own working directory.
const MARKDOWN_LINK = /]\(([^)]+)\)/g;

const TextBlocks = z.looseObject({ content: z.array(z.unknown()) });
const TextBlock = z.looseObject({ type: z.literal("text"), text: z.string() });

// The file a screenshot answer names, inside `outputDir`; undefined for an answer naming none there (an error, an image
// returned inline only).
export const screenshotFileOf = (answer: RpcMessage, outputDir: string): string | undefined => {
    const blocks = TextBlocks.safeParse(answer.result).data?.content ?? [];
    for (const block of blocks) {
        const text = TextBlock.safeParse(block).data?.text ?? "";
        for (const [, link] of text.matchAll(MARKDOWN_LINK)) {
            if (link === undefined) {
                continue;
            }
            const at = link.indexOf(BROWSER_OUTPUT_REL);
            const file = isAbsolute(link) ? link : at === -1 ? undefined : join(outputDir, link.slice(at + BROWSER_OUTPUT_REL.length));
            const inside = file === undefined ? "" : relative(outputDir, resolve(file));
            if (file !== undefined && inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)) {
                return resolve(file);
            }
        }
    }
    return undefined;
};

// The runtime's tool call id, read off the request's MCP `_meta` when its client puts one there.
const ToolCallMeta = z.looseObject({ _meta: z.looseObject({ "claudecode/toolUseId": z.string() }) });

export const toolCallIdOf = (params: Record<string, unknown> | undefined): string | undefined =>
    ToolCallMeta.safeParse(params).data?.["_meta"]["claudecode/toolUseId"];

const PageState = z.object({ url: z.string(), readyState: z.string(), width: z.number(), height: z.number(), deviceScaleFactor: z.number() });

const readPage = async (page: Page): Promise<Pick<ScreenshotProvenance, "url" | "readyState" | "viewport">> => {
    const read = page.evaluate(() => ({
        url: location.href,
        readyState: document.readyState,
        width: innerWidth,
        height: innerHeight,
        deviceScaleFactor: devicePixelRatio,
    }));
    const timeout = new Promise<undefined>((resolveTimeout) => {
        setTimeout(() => resolveTimeout(undefined), READ_TIMEOUT_MS).unref();
    });
    // allow(silent-catch): a page closed or navigating away under the read is described by its address alone.
    const state = PageState.safeParse(await Promise.race([read, timeout]).catch(() => undefined)).data;
    if (state === undefined) {
        return page.isClosed() ? {} : { url: sanitizeUrl(page.url()) };
    }
    return {
        url: sanitizeUrl(state.url),
        readyState: state.readyState,
        viewport: { width: state.width, height: state.height, deviceScaleFactor: state.deviceScaleFactor },
    };
};

export interface ScreenshotTaken {
    readonly outputDir: string;
    readonly browser: string;
    readonly answer: RpcMessage;
    readonly conversationId?: string | undefined;
    readonly toolCallId?: string | undefined;
    // The tab the browser's session last saw a tool touch; undefined when no session tracks this browser.
    readonly page: Page | undefined;
    readonly now?: () => Date;
}

// Writes `<file>.json` beside the shot the answer names, and returns its path; undefined when the answer names no file.
export const writeScreenshotProvenance = async (shot: ScreenshotTaken): Promise<string | undefined> => {
    const file = screenshotFileOf(shot.answer, shot.outputDir);
    if (file === undefined) {
        return undefined;
    }
    const pageState = shot.page === undefined ? {} : await readPage(shot.page);
    const provenance: ScreenshotProvenance = {
        ...(shot.conversationId === undefined ? {} : { conversationId: shot.conversationId }),
        ...(shot.toolCallId === undefined ? {} : { toolCallId: shot.toolCallId }),
        browser: shot.browser,
        ...pageState,
        at: (shot.now?.() ?? new Date()).toISOString(),
    };
    const sidecar = `${file}.json`;
    await writeFile(sidecar, `${JSON.stringify(provenance)}\n`);
    return sidecar;
};
