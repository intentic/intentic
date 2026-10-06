import type { LocationQuery, RouteLocationRaw } from "vue-router";

// Where a link naming a conversation opens it. The daemon's push notifications point at `/?conversation=<id>`
// (sandbox push/notifications.ts, which promises to match this), and so does each of the desktop app's notifications
// about one agent (shell/browser-tab/desktopSignal.ts). Each surface opens it where that reader's chat is drawn:
// - `phone`: the agent route, a conversation's own screen there;
// - `board`: the board's `?focus=` handoff, its card in view and the chat open beside it (side home) or in its window;
// - `chat`: the full-window chat, for a reader who homed the chat on the rail. The board would leave it parked behind
//   the tile, one more press away from the conversation the link named.
// `query` is stated on each so the id does not ride along into the address bar.
export type ConversationSurface = `phone` | `board` | `chat`;

/** The conversation a link names, if it names one. */
export const linkedConversation = (query: LocationQuery): string | undefined => {
    const id = query[`conversation`];
    return typeof id === `string` && id !== `` ? id : undefined;
};

export const conversationRedirect = (query: LocationQuery, surface: ConversationSurface): RouteLocationRaw | undefined => {
    const id = linkedConversation(query);
    if (id === undefined) {
        return undefined;
    }
    switch (surface) {
        case `phone`:
            return { path: `/agents/${encodeURIComponent(id)}`, query: {} };
        case `chat`:
            return { path: `/chat`, query: { focus: id } };
        case `board`:
            return { path: `/agents`, query: { focus: id } };
    }
};
