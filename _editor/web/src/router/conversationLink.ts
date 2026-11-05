import type { LocationQuery } from "vue-router";
import { activeSandboxId } from "../app/storage/activeSandbox";
import { here, page, type PageLink, pageOf, type RouteRead, routeSandbox, toHome, toInside } from "../lib/routes/links";

// Where a link naming a conversation opens it. The daemon's push notifications point at `/?conversation=<id>`
// (sandbox push/notifications.ts, which promises to match this), and so does each of the desktop app's notifications
// about one agent (shell/browser-tab/desktopSignal.ts). Each surface opens it where that reader's chat is drawn:
// - `phone`: the agent's page, a conversation's own screen there;
// - `board`: the board's `?focus=` handoff, its card in view and the chat open beside it (side home) or in its window;
// - `chat`: the full-window chat, for a reader who homed the chat on the rail. The board would leave it parked behind
//   the tile, one more press away from the conversation the link named.
// Each answer is an address with only its own query, so the id does not ride along into the address bar.
export type ConversationSurface = `phone` | `board` | `chat`;

/** The conversation a link names, if it names one. */
export const linkedConversation = (query: LocationQuery): string | undefined => {
    const id = query[`conversation`];
    return id === undefined || id === null || Array.isArray(id) || id === `` ? undefined : id;
};

// On a page of a sandbox the conversation opens in that page's frame and sandbox (links.ts `here`). A link that names
// none (the bare address the notifications use, which lands on Home's own page) opens it inside the sandbox opened last.
const placed = (link: PageLink, route: RouteRead | undefined): string => {
    if (route !== undefined && pageOf(route) !== undefined) {
        return here(link, route);
    }
    const sandbox = (route === undefined ? undefined : routeSandbox(route)) ?? activeSandboxId.value;
    return sandbox === undefined ? toHome() : toInside(sandbox, link);
};

export const conversationRedirect = (query: LocationQuery, surface: ConversationSurface, route?: RouteRead): string | undefined => {
    const id = linkedConversation(query);
    if (id === undefined) {
        return undefined;
    }
    switch (surface) {
        case `phone`:
            return placed(page.agent(id), route);
        case `chat`:
            return placed(page.chat({ query: { focus: id } }), route);
        case `board`:
            return placed(page.agents({ query: { focus: id } }), route);
    }
};
