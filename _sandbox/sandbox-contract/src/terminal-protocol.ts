// The /system/terminal WebSocket wire protocol — JSON text frames both ways (xterm speaks strings), shared by
// the daemon's terminal route and the browser's terminal session so the two can't drift. Plain types, not zod
// schemas: `data` is the per-pty-chunk hot path between two mutually authenticated endpoints, and no oRPC
// eventIterator validates these frames (which is why events.ts uses schemas).

// `ping` is the client's 30s keepalive against tunnel idle-reaping; the server answers with `pong`, so a
// healthy idle connection always sees a frame within the ping interval — silence beyond it means half-open.
export type TerminalClientMessage =
    | { readonly type: "input"; readonly data: string }
    | { readonly type: "resize"; readonly cols: number; readonly rows: number }
    | { readonly type: "ping" };

// `data` is raw pty output; `exit` fires when the tmux client ends (shell exited, or an attach-only session
// doesn't exist) and is terminal — the client never reconnects after it.
export type TerminalServerMessage =
    { readonly type: "data"; readonly data: string } | { readonly type: "exit"; readonly code: number } | { readonly type: "pong" };
