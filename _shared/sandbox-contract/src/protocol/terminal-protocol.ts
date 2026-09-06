// The /system/terminal WebSocket wire protocol, shared by the daemon's terminal route and the browser's
// terminal session so the two can't drift. Plain types, not zod schemas: these are the per-keystroke and
// per-output-chunk hot path between two mutually authenticated endpoints, and no oRPC eventIterator validates
// them (which is why events.ts uses schemas).
//
// TWO FRAME KINDS DOWNSTREAM. The pane's bytes travel as BINARY frames, exactly as the program in the pane
// wrote them, nothing else in the frame: the daemon reads them off tmux's control-mode client (raw, before
// tmux has interpreted them) and xterm in the browser decodes them itself, which is what lets a UTF-8
// character split across two chunks arrive whole. Everything the daemon has to SAY about the connection is a
// JSON text frame (TerminalServerMessage). Upstream is JSON only: input is small and needs no second lane.

// `ping` is the client's 30s keepalive against tunnel idle-reaping; the server answers with `pong`, so a
// healthy idle connection always sees a frame within the ping interval, silence beyond it means half-open.
export type TerminalClientMessage =
    | { readonly type: "input"; readonly data: string }
    | { readonly type: "resize"; readonly cols: number; readonly rows: number }
    | { readonly type: "ping" };

// `exit` fires when the tmux client ends (the shell exited, the session was killed, or an attach-only session
// doesn't exist) and is terminal, the client never reconnects after it. `reason` is tmux's own words where it
// had any ("can't find session: panel-app"), for the browser to print in the dead pane.
export type TerminalServerMessage = { readonly type: "exit"; readonly code: number; readonly reason?: string } | { readonly type: "pong" };
