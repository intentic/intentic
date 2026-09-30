import { createHash, randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";

// The desktop app's half of its sign-in, played the way _editor/desktop-app/src-tauri/src/auth.rs plays it, since this
// tier runs the web app without Tauri. KEEP IN STEP WITH auth.rs: `start` is its `start`, `completePath` its
// `complete_path`, and `readAuthLink` the `intentic://auth` arm of setup_link.rs `parse_link`. Those Rust functions
// have unit tests pinning the same shapes (`the_profile_rides_the_completion…`, `parses_an_auth_handoff`).
//
// The app's windows are Chromium pages here, and what the app would hear from them (a navigation to `intentic://…`,
// which Tauri intercepts in Rust) is read off Chrome DevTools' `Page.frameRequestedNavigation`, which reports the link
// verbatim before Chromium gives up on a scheme with no handler.

export interface Attempt {
    readonly state: string;
    readonly verifier: string;
    // The page auth.rs opens in the default browser.
    readonly path: string;
}

/** auth.rs `start`: a nonce, a verifier only the app holds, and the page carrying the verifier's challenge. */
export const startAttempt = (options?: { readonly switchAccount?: boolean }): Attempt => {
    const state = randomUUID();
    const verifier = `${randomUUID().replaceAll(`-`, ``)}${randomUUID().replaceAll(`-`, ``)}`;
    const challenge = createHash(`sha256`).update(verifier).digest(`base64url`);
    const switchAccount = options?.switchAccount === true ? `&switch=1` : ``;
    return { state, verifier, path: `/desktop-auth?state=${state}&challenge=${challenge}${switchAccount}` };
};

export interface AuthLink {
    readonly handoff: string;
    readonly state: string;
    readonly profile?: string;
}

/** setup_link.rs `parse_link`, the `auth` arm: a handoff and a state, or no link at all. */
export const readAuthLink = (link: string): AuthLink | undefined => {
    const url = URL.parse(link);
    if (url === null || url.protocol !== `intentic:` || url.host !== `auth`) {
        return undefined;
    }
    const handoff = url.searchParams.get(`handoff`);
    const state = url.searchParams.get(`state`);
    const profile = url.searchParams.get(`profile`);
    if (handoff === null || handoff === `` || state === null || state === ``) {
        return undefined;
    }
    return { handoff, state, ...(profile === null ? {} : { profile }) };
};

/** auth.rs `complete_path`: where the app points its workspace window once the browser hands the sign-in back. */
export const completePath = (handoff: string, verifier: string, profile?: string): string =>
    `/desktop-auth/complete?handoff=${handoff}&verifier=${verifier}${profile === undefined ? `` : `&profile=${profile}`}`;

/**
 * What Tauri injects into each of the app's windows before any script (`window.__INTENTIC_DESKTOP__`,
 * environments/desktop.ts `DesktopWebview`), which is how the page knows it is the webview: no Google button of its
 * own, and sign-in handed to the browser over `intentic://signin`.
 */
export const becomeTheAppWebview = async (context: BrowserContext): Promise<void> => {
    await context.addInitScript(() => {
        window.__INTENTIC_DESKTOP__ = { version: `0.0.0-e2e`, installId: `signin-e2e`, update: null };
    });
};

declare global {
    interface Window {
        __INTENTIC_DESKTOP__?: { version: string; installId: string; update: string | null };
    }
}

export interface DeepLinks {
    /** The first `intentic:` link this page asked for that starts with `prefix`, waiting up to `timeoutMs` for one. */
    readonly next: (prefix: string, timeoutMs?: number) => Promise<string>;
    /** Every `intentic:` link asked for so far, in order. */
    readonly seen: readonly string[];
}

/** Starts hearing the `intentic:` links `page` asks for, as the app would. Call before the action that sends one. */
export const listenForDeepLinks = async (page: Page): Promise<DeepLinks> => {
    const seen: string[] = [];
    const taken = new Set<number>();
    const waiters = new Set<{ readonly prefix: string; readonly resolve: (link: string) => void }>();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send(`Page.enable`);
    cdp.on(`Page.frameRequestedNavigation`, ({ url }) => {
        if (!url.startsWith(`intentic:`)) {
            return;
        }
        seen.push(url);
        for (const waiter of waiters) {
            if (url.startsWith(waiter.prefix)) {
                taken.add(seen.length - 1);
                waiters.delete(waiter);
                waiter.resolve(url);
                return;
            }
        }
    });
    const next = (prefix: string, timeoutMs = 20_000): Promise<string> => {
        const waiting = seen.findIndex((link, index) => !taken.has(index) && link.startsWith(prefix));
        if (waiting !== -1) {
            taken.add(waiting);
            return Promise.resolve(seen[waiting] as string);
        }
        return new Promise<string>((resolve, reject) => {
            const waiter = { prefix, resolve };
            waiters.add(waiter);
            setTimeout(() => {
                if (waiters.delete(waiter)) {
                    reject(new Error(`no ${prefix} link within ${timeoutMs}ms; the page asked for: ${seen.length === 0 ? `nothing` : seen.join(`, `)}`));
                }
            }, timeoutMs);
        });
    };
    return { next, seen };
};
