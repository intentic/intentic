import { inject, type InjectionKey } from "vue";

/* WHAT A TOOL CARD CAN REACH BEYOND ITSELF — and the reason there is exactly one card renderer.
 *
 * A card draws a RECORD: a path that was read, a command that ran, a picture that was taken. Where that record
 * can be FOLLOWED is not a property of the record — it is a property of who is looking at it. In the app a path
 * opens the workspace, a running command has a shell to attach to, and a delegation has a transcript page. On a
 * conversation published to the public there is no workspace behind the page, nothing to attach to and nowhere
 * to navigate; the same card has to draw the same record with nothing to click.
 *
 * So the reachable half is INJECTED rather than imported. The alternative is a second, read-only copy of the
 * card, and a copy is the thing that drifts: every per-tool rendering decision this app makes lands in one
 * place (toolPresentation.ts + ChatToolCard.vue), and a shared conversation that slowly stops looking like the
 * app is a shared conversation nobody trusts is really what they saw.
 *
 * An absent surface offers nothing rather than throwing, which is also what makes a card mountable outside the
 * chat — a subagent's transcript page renders the same cards and is not inside a pane. */
export interface ChatSurface {
    // A workspace path as something an <img> can show, or undefined while there is nothing to show. The one
    // capability every surface has some answer for, hence not optional: the app re-mints a thumbnail from the
    // workspace, a shared page points at the copy sitting beside it, and an inert surface says "no picture".
    readonly imageUrl: (path: string) => string | undefined;
    // Open a workspace file, at a line where one is known. Absent ⇒ paths render as text, not buttons.
    readonly openFile?: (path: string, line?: number) => void;
    // The live shell behind a command card, and the door onto it. Both or neither.
    readonly commandTerminal?: () => string | undefined;
    readonly watchTerminal?: (session: string) => void;
    // The live browser behind a browser card, on the same terms.
    readonly commandBrowser?: () => string | undefined;
    readonly watchBrowser?: (session: string) => void;
    /* Where a delegation's own transcript lives, as a route. Absent ⇒ the card carries no link to it.
     *
     * A route STRING plus `navigate`, rather than a <RouterLink> in the card, because the card must render
     * where there is no router at all. A compiled template resolves every component it mentions when the
     * render function runs — `v-if="false"` does not save it — so naming RouterLink here would put vue-router
     * into a published page's bundle to satisfy an element that page never draws. The href is real either way,
     * which is what keeps middle-click and "copy link address" working in the app. */
    readonly subagentRoute?: (toolId: string) => string;
    // How a route is entered without a page load. Present wherever `subagentRoute` is.
    readonly navigate?: (route: string) => void;
}

// A record with nothing to follow: no pictures resolve and nothing is clickable. What a published conversation
// provides verbatim, and what a card mounted outside the chat falls back to.
export const INERT_SURFACE: ChatSurface = { imageUrl: () => undefined };

export const CHAT_SURFACE: InjectionKey<ChatSurface> = Symbol(`chat-surface`);

export const useChatSurface = (): ChatSurface => inject(CHAT_SURFACE, INERT_SURFACE);
