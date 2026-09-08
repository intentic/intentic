// The /system/terminal WebSocket wire protocol, shared by the daemon and browser terminal so the two can't drift. Plain
// types, not zod, since this is a per-keystroke hot path nothing validates. Pane bytes travel as raw binary frames (so
// a split UTF-8 char decodes whole); everything else is JSON.

// `ping` is the client's 30s keepalive against tunnel idle-reaping; `pong` answers it, so silence beyond the interval
// means half-open.
export type TerminalClientMessage =
    | { readonly type: "input"; readonly data: string }
    | { readonly type: "resize"; readonly cols: number; readonly rows: number }
    | { readonly type: "ping" };

// `exit` is terminal (no reconnect) when the tmux client ends; `reason` is tmux's own words, if any, for the dead pane.
export type TerminalServerMessage = { readonly type: "exit"; readonly code: number; readonly reason?: string } | { readonly type: "pong" };
