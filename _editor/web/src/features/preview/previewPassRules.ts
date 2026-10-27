import { hostOwnerId } from "@intentic/sandbox-contract/ids/hostnames";
import type { LocationQuery } from "vue-router";
import { z } from "zod";
import { deviceKey, removeStoredValue, storedJson, storeJson } from "../../app/storage/browserStorage";

// A GUARDED PREVIEW'S PASS, as the editor fetches one (sandbox-contract schemas/ports.ts, `ports.previewPass`). A
// preview the owner keeps to members answers a browser that holds no pass for it with a page of its own: framed, that
// page asks the frame's parent for one (`{ intentic: "preview-pass", href }`); opened in a tab, it links to the editor's
// `/preview-pass?url=`. Either way the editor asks the preview's daemon for a one-time link to the same address, which
// leaves the browser holding the pass, and sends the browser through it. Only the daemon's answer is ever navigated to,
// and the daemon refuses any address that is not one of its own: that is what keeps both doors from being an open
// redirect. What is here decides; usePreviewPass.ts (a Browsers tab's frame) and PreviewPass.vue do the asking.

// A browser that does not keep the pass (cookies blocked for the preview's site, or blocked in frames) is back asking
// for another as soon as it lands. Within this long of the last pass, the editor explains instead of minting again.
export const PASS_AGAIN_MS = 30_000;

/** Whether an ask comes so soon after the last pass that the browser cannot have kept it. */
export const passAskedTooSoon = (lastPassAt: number | undefined, now: number): boolean => lastPassAt !== undefined && now - lastPassAt < PASS_AGAIN_MS;

// An address's origin, for the web addresses a preview has; undefined for one that does not parse, or one with no
// origin of its own (`data:`, `javascript:`), all of which share the origin "null" and so must never compare equal.
const originOf = (url: string): string | undefined => {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        // allow(silent-catch): an address that does not parse has no origin, which is the answer.
        return undefined;
    }
    return parsed.protocol === `https:` || parsed.protocol === `http:` ? parsed.origin : undefined;
};

const sameOrigin = (url: string, other: string): boolean => {
    const origin = originOf(url);
    return origin !== undefined && origin === originOf(other);
};

// What the guarded page posts to the frame's parent.
const PassAskSchema = z.object({ intentic: z.literal(`preview-pass`), href: z.string().min(1).max(4096) });

/**
 * The address a framed preview asks a pass for: only from the tab's own frame, in the guarded page's shape, and about
 * the preview's own public origin. Any other message, from anywhere else or about any other origin, is undefined.
 */
export const passAskFrom = (
    event: { readonly source: MessageEventSource | null; readonly data: unknown },
    frame: MessageEventSource | null | undefined,
    previewUrl: string | undefined,
): string | undefined => {
    if (frame === null || frame === undefined || event.source !== frame || previewUrl === undefined) {
        return undefined;
    }
    const ask = PassAskSchema.safeParse(event.data);
    return ask.success && sameOrigin(ask.data.href, previewUrl) ? ask.data.href : undefined;
};

/** The daemon's answer, followed only where it leads to the asked address's own origin, as the one-time link does. */
export const passLinkFor = (answer: string, asked: string): string | undefined => (sameOrigin(answer, asked) ? answer : undefined);

/** What `/preview-pass?url=` names: a preview's address on a sandbox's name, with the platform's id for that sandbox. */
export interface PassRequest {
    readonly url: string;
    readonly host: string;
    readonly sandboxId: string;
}

// The one query key the page reads; given twice (a list) or bare, it names no address.
const PassQuerySchema = z.object({ url: z.string().min(1).max(4096) });

/** The query's `url`, when it is one https address whose name carries a sandbox's id; a list, a blank or anything else is none. */
export const passRequestOf = (query: LocationQuery): PassRequest | undefined => {
    const named = PassQuerySchema.safeParse(query);
    if (!named.success) {
        return undefined;
    }
    let parsed: URL;
    try {
        parsed = new URL(named.data.url);
    } catch {
        // allow(silent-catch): a value that is not an address names no preview.
        return undefined;
    }
    const sandboxId = parsed.protocol === `https:` ? hostOwnerId(parsed.host) : undefined;
    return sandboxId === undefined ? undefined : { url: parsed.toString(), host: parsed.host, sandboxId };
};

// The last pass this tab was sent through, by the preview's host: in the tab's own storage, since the page that reads it
// is a fresh load of the editor each time the preview sends the browser back.
const LAST_PASS_KEY = deviceKey(`intentic.previewPass`);
const LastPassSchema = z.object({ host: z.string(), at: z.number() });

/** Whether this tab was sent through a pass to `host` too recently for the browser to be asking again with it kept. */
export const passedTooRecently = (host: string, now: number): boolean => {
    const last = storedJson(LAST_PASS_KEY, LastPassSchema, `session`);
    return last?.host === host && passAskedTooSoon(last.at, now);
};

export const rememberPass = (host: string, now: number): void => storeJson(LAST_PASS_KEY, { host, at: now }, `session`);

/** Clears the memory, for an explicit try again once the person has changed what kept the browser from holding it. */
export const forgetPass = (): void => removeStoredValue(LAST_PASS_KEY, `session`);
