import { isNoTmuxServer, isNoTmuxTarget } from "./tmux-server.js";

// The stderr tmux 3.5a writes for each case, carried on execFile's rejection the way a real call carries it.
const exited = (stderr: string): Error => Object.assign(new Error("Command failed: tmux list-panes -a"), { code: 1, stderr });

test("no server, no socket and no tmux binary all mean no sessions", () => {
    expect(isNoTmuxServer(exited("no server running on /tmp/tmux-0/default\n"))).toBe(true);
    expect(isNoTmuxServer(exited("error connecting to /tmp/tmux-0/default (No such file or directory)\n"))).toBe(true);
    expect(isNoTmuxServer(Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" }))).toBe(true);
});

// The pinned server between boot and the first terminal: alive, empty, and answering every lookup this way. Read as a
// failure, it kept the boot restore from starting dockerd and the local model server.
test("a running server that holds no session means no sessions too", () => {
    expect(isNoTmuxServer(exited("no current target\n"))).toBe(true);
});

test("a listing that failed for any other reason is not an empty answer", () => {
    expect(isNoTmuxServer(exited("error connecting to /tmp/tmux-0/default (Permission denied)\n"))).toBe(false);
    expect(isNoTmuxServer(Object.assign(new Error("spawn tmux EAGAIN"), { code: "EAGAIN" }))).toBe(false);
    expect(isNoTmuxServer(Object.assign(new Error("Command failed: tmux list-panes -a"), { killed: true, signal: "SIGTERM", stderr: "" }))).toBe(false);
    expect(isNoTmuxServer(new TypeError("stdout.split is not a function"))).toBe(false);
});

// A lookup by name on a server that holds other sessions: 3.5a names a window even for a `-t =session` lookup.
test("a named session or window that is not there is no target, and so is no server", () => {
    expect(isNoTmuxTarget(exited("can't find window: agent-abcd1234\n"))).toBe(true);
    expect(isNoTmuxTarget(exited("can't find session: agent-abcd1234\n"))).toBe(true);
    expect(isNoTmuxTarget(exited("no server running on /tmp/tmux-0/default\n"))).toBe(true);
    expect(isNoTmuxServer(exited("can't find window: agent-abcd1234\n"))).toBe(false);
});

test("a lookup that failed for any other reason is not a missing target", () => {
    expect(isNoTmuxTarget(exited("error connecting to /tmp/tmux-0/default (Permission denied)\n"))).toBe(false);
    expect(isNoTmuxTarget(new TypeError("stdout.split is not a function"))).toBe(false);
});
