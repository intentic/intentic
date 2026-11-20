import type { TerminalClientMessage } from "@intentic/sandbox-contract/browser-wire";

// WHERE A TERMINAL SESSION'S SOCKET DIALS (features/terminal/terminalSession.ts). The sandbox's own tmux sessions on /system/terminal by
// default; a door for a pane that lives elsewhere and speaks the same protocol (a connected computer's shell on
// /system/device-terminal, deviceTerminals.ts) names its own route and token, and renews that token on
// the open socket (`{type: "token"}`). Its own module, so a suite that fakes the session module wholesale still links
// whatever builds a door.

/** What an attach asks for: the session, its grid and directory, whether it is out of sight, and deflated bytes. */
export type TerminalParams = { session: string; cols: string; rows: string; cwd?: string; away?: `1`; deflate?: `1` };

/** A socket's address: the sandbox's base, the route on it, and the query the upgrade presents. */
export interface TerminalAddress {
    readonly base: string;
    readonly path: string;
    readonly query: string;
}

export interface TerminalDoor {
    // The address for this attach, carrying the grid asked for; undefined while there is nowhere to dial. A TerminalGone
    // throw ends the session as its exit would.
    readonly address: (params: TerminalParams) => Promise<TerminalAddress | undefined>;
    // The socket opened: what the door says on it from here (a renewed token) goes through `send`.
    readonly opened?: (send: (message: TerminalClientMessage) => void) => void;
    readonly dispose?: () => void;
}

/** A door's word that its session is gone at the far end: nothing to attach to, and nothing to wait for. */
export class TerminalGone extends Error {}
