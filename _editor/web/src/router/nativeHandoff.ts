import { useTheme } from "@intentic/ui/theme";
import { type DaemonSession, DaemonSessionSchema } from "@intentic/sandbox-contract/schemas/system";
import type { LocationQuery, RouteLocationNormalized, RouteLocationRaw, Router } from "vue-router";
import { z } from "zod";
import { EMBED_QUERY, embedded, LOOK_QUERY, type NativeLook, nativeLook, nativeLookOf, rememberLook, tellNative } from "../app/environments/nativeApp";
import { type ThemeRow, themeRowLook } from "../skins/themeRow";
import { returnPath } from "../lib/routes/signIn";
import { legacyPathOf, legacySandbox, page, type PageLink, parseAppPath, topPath } from "@intentic/sandbox-contract/app-routes";
import { linkOf } from "../lib/routes/links";
import { AGENT_VIEW, CHANGES_VIEW } from "../lib/routes/phoneScreens";
import { useSkin } from "../skins/useSkin";
import { linkedConversation } from "./conversationLink";

// THE ANDROID APP'S HALF OF THE ROUTER (app/environments/nativeApp.ts says what the app is). Installed only in its
// WebView, so a browser gets none of it:
// - a navigation to a screen the app draws itself is handed to it (`intenticNative.open`) and goes nowhere here, whoever
//   started it: a link, a press, a redirect, a guard sending a signed-out reader to /login;
// - the app's back gesture and toolbar ask this page for a step back through `intenticEmbed.back()`, which answers
//   whether there was one, so the app closes the WebView when there was not;
// - the app shows another route in the warm page with `intenticEmbed.open(path)`, hands over the look it wears with
//   `setLook`, and a daemon session it already holds with `adoptSession`.
//
// The app is told every address in the form addresses had before frames (legacy.ts `legacyPathOf`), its sandbox named
// as `?sandbox=`: every installed app parses `/agents/<id>` to open a conversation natively and reads `?sandbox=` to hand
// over that sandbox's session before it shows a path again. The page reads either form, so the app's own paths land.

const SIGN_IN = topPath(`login`);

/** What the hand-off reads of a route: a guard's and one the router resolved alike. */
export type NativeRoute = Pick<RouteLocationNormalized, `path` | `query` | `fullPath`>;

// What arrives unchecked, from an address or from Kotlin: a word, or vue-router's own history entry.
const WordSchema = z.string().min(1);
const HistoryEntrySchema = z.object({ position: z.number() });

const focused = (query: LocationQuery): string | undefined => WordSchema.safeParse(query[`focus`]).data;

// What a route shows, read off its address in either form (links.ts `linkOf`), and the sandbox that address names: its
// frame's (`/s/<sandbox>/…`, `/home/<sandbox>/…`), or an old address's `?sandbox=`.
const shownBy = (to: NativeRoute): { readonly link: PageLink; readonly sandbox: string | undefined } | undefined => {
    const link = linkOf(to.fullPath);
    if (link === undefined) {
        return undefined;
    }
    const framed = parseAppPath(to.path);
    return { link, sandbox: framed === undefined ? legacySandbox(to.fullPath) : framed.frame.sandbox };
};

// A conversation's own screen as the app's bridge reads it, `/agents/<id>` (the id escaped), in the sandbox named.
const nativeChatPath = (conversationId: string, sandbox: string | undefined): string => legacyPathOf(page.agent(conversationId), sandbox);

/** A screen the app draws itself: a path as it reads one, or the chat, whose open conversation only the guard can read. */
export type NativeScreen = { readonly kind: `open`; readonly path: string } | { readonly kind: `chat`; readonly sandbox: string | undefined };

/**
 * The screen the app draws for a route, undefined for a route this page shows. A conversation is always its own screen,
 * however the route named it: `?conversation=`, the board's or the chat's `?focus=`. The chat alone is the conversation
 * it has open. The board and the menu keep their query, and the sign-in pages their whole address. Two pages under an
 * agent stay here, since the app shows them in this page: its Changes alone (`view=changes`, AgentDetail) and one page
 * it showed, full screen (the agent's pages, ChatPageScreen).
 */
export const nativeScreen = (to: NativeRoute): NativeScreen | undefined => {
    const shown = shownBy(to);
    const name = shown?.link.page;
    const named = linkedConversation(to.query) ?? (name === `chat` || name === `agents` ? focused(to.query) : undefined);
    if (named !== undefined) {
        return { kind: `open`, path: nativeChatPath(named, shown?.sandbox) };
    }
    if (to.path === SIGN_IN || to.path.startsWith(`${SIGN_IN}/`)) {
        return { kind: `open`, path: to.fullPath };
    }
    if (shown === undefined) {
        return undefined;
    }
    if (name === `chat`) {
        return { kind: `chat`, sandbox: shown.sandbox };
    }
    const drawn = name === `agents` || name === `menu` || (name === `agent` && to.query[AGENT_VIEW] !== CHANGES_VIEW);
    return drawn ? { kind: `open`, path: legacyPathOf(shown.link, shown.sandbox) } : undefined;
};

/**
 * Where the page is, as the app is told after each navigation (`routed`) and shows again later: a page of a sandbox in
 * the form the app reads, its sandbox named; any other address as it is.
 */
export const nativeRoutedPath = (to: NativeRoute): string => {
    const shown = shownBy(to);
    return shown === undefined ? to.fullPath : legacyPathOf(shown.link, shown.sandbox);
};

/** The route without the app's two address keys, which the page has read and remembered; undefined when it has neither. */
export const withoutEmbedQuery = (to: Pick<RouteLocationNormalized, `path` | `query` | `hash`>): RouteLocationRaw | undefined => {
    if (!(EMBED_QUERY in to.query) && !(LOOK_QUERY in to.query)) {
        return undefined;
    }
    const { [EMBED_QUERY]: _embed, [LOOK_QUERY]: _look, ...query } = to.query;
    return { path: to.path, query, hash: to.hash, replace: true };
};

/** Whether there is a step back in this page's own history: an entry above the one the app opened it on. */
export const hasStepBack = (position: number | undefined, root: number | undefined): boolean =>
    position !== undefined && root !== undefined && position > root;

/** What the page answers the app with (`window.intenticEmbed`); every argument arrives unchecked from Kotlin. */
export interface IntenticEmbed {
    /** One step back through this page's history, a sheet's own entry included; false when there is none. */
    back(): boolean;
    /** Shows a route in this page without a reload; false for a path it refuses or a screen the app draws. */
    open(path: string): boolean;
    /** Wears one of the four looks over the reader's own choice, without storing it; false for a look it does not know. */
    setLook(look: string): boolean;
    /** Keeps a daemon session the app already holds for a sandbox, so this page needs no sign-in of its own there. */
    adoptSession(sandboxId: string, session: DaemonSession): boolean;
}

declare global {
    interface Window {
        intenticEmbed?: IntenticEmbed;
    }
}

export interface NativeAppHost {
    /** Shows a path the way a link arriving would, a `?sandbox=` in it choosing that sandbox (index.ts `openInPage`). */
    readonly show: (path: string) => Promise<void>;
    /** The conversation the chat has open, which `/chat` means. */
    readonly activeConversation: () => Promise<string>;
    /** Stores a daemon session for a sandbox (sandboxSession.ts `adoptSession`). */
    readonly adoptSession: (sandboxId: string, session: DaemonSession) => void;
    /** Where this page stands in the tab's history: vue-router's `position`, which a sheet's own entry carries too. */
    readonly position?: () => number | undefined;
    /** One step back through the tab's history, the one a sheet listens for. */
    readonly stepBack?: () => void;
}

const historyPosition = (): number | undefined => HistoryEntrySchema.safeParse(globalThis.history?.state).data?.position;

// Both halves of a look at once, as the Theme row stores them, but worn rather than stored.
const wear = (look: NativeLook): void => {
    const row: ThemeRow = look;
    const pair = themeRowLook(row);
    useSkin().hand(pair.skin);
    useTheme().hand(pair.scheme);
};

/** Installs the hand-off, the back the app asks for, and the look it wears; nothing at all outside the app. */
export const installNativeApp = (router: Router, host: NativeAppHost): void => {
    if (!embedded()) {
        return;
    }
    const position = host.position ?? historyPosition;
    const stepBack = host.stepBack ?? (() => globalThis.history.back());
    // The entry the app opened this page on: back never goes below it, since what lies under it is the app's.
    let root = position();
    const canGoBack = (): boolean => hasStepBack(position(), root);

    const look = nativeLook();
    if (look !== undefined) {
        wear(look);
    }

    router.beforeEach(async (to) => {
        const clean = withoutEmbedQuery(to);
        if (clean !== undefined) {
            return clean;
        }
        const screen = nativeScreen(to);
        if (screen === undefined) {
            return true;
        }
        const path = screen.kind === `chat` ? nativeChatPath(await host.activeConversation(), screen.sandbox) : screen.path;
        // An app that cannot hear it leaves the page to go there itself, as a browser would.
        return !tellNative({ kind: `open`, path });
    });

    router.afterEach((to, _from, failure) => {
        root ??= position();
        if (failure === undefined) {
            tellNative({ kind: `routed`, path: nativeRoutedPath(to), title: to.meta.title?.() ?? ``, canGoBack: canGoBack() });
        }
    });

    globalThis.window.intenticEmbed = {
        back: () => {
            if (!canGoBack()) {
                return false;
            }
            stepBack();
            return true;
        },
        open: (asked) => {
            const path = WordSchema.safeParse(asked).data;
            if (path === undefined || returnPath(path) !== path || nativeScreen(router.resolve(path)) !== undefined) {
                return false;
            }
            void host.show(path).then(() => {
                root = position();
            });
            return true;
        },
        setLook: (asked) => {
            const named = nativeLookOf(WordSchema.safeParse(asked).data);
            if (named === undefined) {
                return false;
            }
            wear(named);
            rememberLook(named);
            return true;
        },
        adoptSession: (asked, session) => {
            const sandboxId = WordSchema.safeParse(asked).data;
            const parsed = DaemonSessionSchema.safeParse(session).data;
            if (sandboxId === undefined || parsed === undefined || parsed.expiresAt <= Date.now()) {
                return false;
            }
            host.adoptSession(sandboxId, parsed);
            return true;
        },
    };
};
