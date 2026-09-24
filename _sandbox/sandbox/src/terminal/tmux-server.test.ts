import { isNoTmuxServer } from "./tmux-server.js";

// The stderr tmux 3.5a writes for each case, carried on execFile's rejection the way a real call carries it.
const exited = (stderr: string): Error => Object.assign(new Error("Command failed: tmux list-panes -a"), { code: 1, stderr });

test("no server, no socket and no tmux binary all mean no sessions", () => {
    expect(isNoTmuxServer(exited("no server running on /tmp/tmux-0/default\n"))).toBe(true);
    expect(isNoTmuxServer(exited("error connecting to /tmp/tmux-0/default (No such file or directory)\n"))).toBe(true);
    expect(isNoTmuxServer(Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" }))).toBe(true);
});

test("a listing that failed for any other reason is not an empty answer", () => {
    expect(isNoTmuxServer(exited("error connecting to /tmp/tmux-0/default (Permission denied)\n"))).toBe(false);
    expect(isNoTmuxServer(Object.assign(new Error("spawn tmux EAGAIN"), { code: "EAGAIN" }))).toBe(false);
    expect(isNoTmuxServer(Object.assign(new Error("Command failed: tmux list-panes -a"), { killed: true, signal: "SIGTERM", stderr: "" }))).toBe(false);
    expect(isNoTmuxServer(new TypeError("stdout.split is not a function"))).toBe(false);
});
