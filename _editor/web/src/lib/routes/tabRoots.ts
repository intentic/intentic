// The phone's tab geometry as pure rules, importable by the router and the shell without the composables' graph.

/** The phone's chat surface for a conversation: the agent route, since a conversation is its own screen there. */
export const mobileChatPath = (conversationId: string): string => `/agents/${encodeURIComponent(conversationId)}`;

// A tab's own screen. `panel` is stated only where two tabs share a path (Review's Changes panel under /workspace);
// absent, the path alone decides.
export interface TabRoot {
    readonly path: string;
    readonly panel?: string;
}

/** A tab destination (`/workspace?panel=changes`) as a root. */
export const parseRoot = (to: string): TabRoot => {
    const [path = to, query = ``] = to.split(`?`);
    const panel = new URLSearchParams(query).get(`panel`);
    return panel === null ? { path } : { path, panel };
};

/** Where the reader is: the route's path and its `panel` query, absent meaning the workspace's files. */
export interface TabPlace {
    readonly path: string;
    readonly panel?: string | undefined;
}

/** Is `at` a tab's own screen, or a drill-down inside one (a file, an agent) that owns its own way back. */
export const onTabRoot = (at: TabPlace, roots: readonly TabRoot[]): boolean =>
    roots.some((root) => {
        if (!(at.path === root.path || at.path.startsWith(`${root.path}/`))) {
            return false;
        }
        return root.panel === undefined || (at.panel ?? `files`) === root.panel;
    });
