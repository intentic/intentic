import type { LocationQuery, RouteLocationRaw } from "vue-router";

// Where a link naming a conversation opens it. The daemon's push notifications point at `/?conversation=<id>`
// (sandbox push/notifications.ts, which promises to match this); the phone's chat surface is the agent route, the
// desktop's is the docked chat the board's `?focus=` handoff opens. `query` is stated on both so the id does not
// ride along into the address bar.
export const conversationRedirect = (query: LocationQuery, mobile: boolean): RouteLocationRaw | undefined => {
    const id = query[`conversation`];
    if (typeof id !== `string` || id === ``) {
        return undefined;
    }
    return mobile ? { path: `/agents/${encodeURIComponent(id)}`, query: {} } : { path: `/agents`, query: { focus: id } };
};
