// Where a desk member may stand in the shell: the chat it drives, the board of its own conversations, its own
// settings, and the one sandbox section it has business in. Everywhere else the daemon refuses every read, so the
// shell sends it home rather than draw a screen of refusals. The daemon is the fence; this only spares the screen.
// Pure, apart from the composable that applies it (deskFence.ts), so the table can be pinned without a window.

export const DESK_HOME = `/chat`;

// Matched on prefixes, since chat, agents and settings all carry their own sub-paths.
const DESK_ROOTS = [`/chat`, `/agents`, `/agent/`, `/settings`, `/sandbox/access`, `/accept-invite`, `/login`, `/floating/chat`] as const;

export const deskAllowedPath = (path: string): boolean => DESK_ROOTS.some((root) => path === root || path.startsWith(root.endsWith(`/`) ? root : `${root}/`));
