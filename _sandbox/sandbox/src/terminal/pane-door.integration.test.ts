import { mkdtemp, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { agentPaneLine, forgetNamespaceEntry, registerAgentDomainEntry, registerMountEntry, type NamespaceEntryReference } from "../workload/namespace-entry.js";
import { openPaneDoor, PANE_EPITAPH, type PaneDoor } from "./pane-door.js";

// A real door on a real socket in a temp dir, with tmux answered by a fake that records every call: what the door asks
// tmux to do for a domain, and what it refuses to do, without a tmux server or a namespace.

interface Call { readonly args: readonly string[] }
const missing = (): Error => Object.assign(new Error("tmux exited 1"), { stderr: "can't find session: agent-abc12345\n" });

const fakeTmux = (answers: (args: readonly string[]) => string | Error) => {
    const calls: Call[] = [];
    return {
        calls,
        tmux: async (args: readonly string[]): Promise<string> => {
            calls.push({ args });
            const answer = answers(args);
            if (answer instanceof Error) {
                throw answer;
            }
            return answer;
        },
    };
};

const ask = async (socket: string, method: "GET" | "POST", path: string, form?: Record<string, string>): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
        const body = form === undefined ? "" : new URLSearchParams(form).toString();
        const req = request({ socketPath: socket, method, path, headers: { "content-type": "application/x-www-form-urlencoded" } }, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
                text += chunk;
            });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text.trim() }));
        });
        req.on("error", reject);
        req.end(body);
    });

const OPEN = { session: "agent-abc12345", name: "build", cwd: `${WORKSPACE_ROOT}/apps/web`, runner: `${HISTORY_ROOT}/agent-run/c-c1/tmp/intentic-run-x/runner` };

let dir: string;
let domain: NamespaceEntryReference;
const doors: PaneDoor[] = [];
const open = async (answers: (args: readonly string[]) => string | Error, owner: string | undefined = "c1") => {
    const fake = fakeTmux(answers);
    const door = await openPaneDoor({ owner, logger: { warn: () => {} }, tmux: fake.tmux, dir, provision: async () => {} });
    doors.push(door);
    return { door, calls: fake.calls };
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pane-door-"));
    domain = registerAgentDomainEntry(424_242, { userNamespace: "/proc/424241/ns/user", home: "/home/agent" });
});
afterEach(async () => {
    await Promise.all(doors.splice(0).map(async (door) => door.close()));
    forgetNamespaceEntry(domain);
    await rm(dir, { recursive: true, force: true });
});

test("refuses every request until the domain it serves exists", async () => {
    const { door, calls } = await open(() => "%1\n");
    expect(await ask(door.socket, "POST", "/open", OPEN)).toEqual({ status: 503, body: "this domain is not ready" });
    expect(calls).toEqual([]);
});

test("opens a new session's first window with the domain's own way in, remain-on-exit and the owner stamp in one command", async () => {
    const { door, calls } = await open((args) => (args[0] === "display-message" ? missing() : "%7\n"));
    door.attach(domain);
    expect(await ask(door.socket, "POST", "/open", OPEN)).toEqual({ status: 200, body: "%7" });
    const session = "=agent-abc12345:";
    expect(calls.map((call) => call.args)).toEqual([
        ["display-message", "-p", "-t", session, "#{@intentic_owner}"],
        [
            "new-session", "-d", "-s", "agent-abc12345", "-P", "-F", "#{pane_id}", "-n", "build", "-c", "/",
            agentPaneLine(domain, "/work/apps/web", "bash", [OPEN.runner]),
            ";", "set-option", "-w", "-t", session, "remain-on-exit", "on",
            ";", "set-option", "-w", "-t", session, "remain-on-exit-format", PANE_EPITAPH,
            ";", "set-option", "-t", session, "@intentic_owner", "c1",
        ],
        ["list-panes", "-s", "-t", "=agent-abc12345", "-F", "#{pane_dead} #{window_id} #{pane_id}"],
    ]);
});

test("the pane line enters mount and pid as root, takes the terminal in a session of its own, then drops into the user namespace", () => {
    expect(agentPaneLine(domain, "/work", "bash", ["/tmp/x/runner"])).toBe(
        "exec 9</proc/424241/ns/user; exec /usr/bin/nsenter --target=424242 --mount --pid --wdns=/work -- /usr/bin/setsid --ctty " +
            "/usr/bin/nsenter --user=/proc/self/fd/9 --setuid=0 --setgid=0 -- setpriv --no-new-privs env -u PWD -u OLDPWD " +
            "HOME=/home/agent USER=agent LOGNAME=agent XDG_RUNTIME_DIR=/run/user/0 bash /tmp/x/runner",
    );
    // A plain root mount anchor is never a way into a domain.
    const mount = registerMountEntry(424_243);
    try {
        expect(() => agentPaneLine(mount, "/work", "bash", [])).toThrow("agent domain anchor 424243 is not registered");
    } finally {
        forgetNamespaceEntry(mount);
    }
});

test("adds a window to an existing session of its own conversation", async () => {
    const { door, calls } = await open((args) => (args[0] === "display-message" ? "c1\n" : "%9\n"));
    door.attach(domain);
    expect(await ask(door.socket, "POST", "/open", OPEN)).toEqual({ status: 200, body: "%9" });
    expect(calls[1]?.args.slice(0, 3)).toEqual(["new-window", "-t", "=agent-abc12345:"]);
});

test("refuses a session another conversation owns, and opens nothing", async () => {
    const { door, calls } = await open((args) => (args[0] === "display-message" ? "c2\n" : "%9\n"));
    door.attach(domain);
    expect(await ask(door.socket, "POST", "/open", OPEN)).toEqual({ status: 403, body: "that session belongs to another conversation" });
    expect(calls.map((call) => call.args[0])).toEqual(["display-message"]);
});

test("refuses names and paths that are not the hook's: another prefix, a relative or unclean path, a newline, a non-runner", async () => {
    const { door, calls } = await open(() => "%1\n");
    door.attach(domain);
    for (const bad of [
        { session: "main" },
        { session: "agent-abc12345; kill-server" },
        { name: "Build Me" },
        { cwd: "work" },
        { cwd: `${WORKSPACE_ROOT}/../root` },
        { cwd: "/work\n/root" },
        { runner: "/tmp/x/script" },
    ]) {
        expect(await ask(door.socket, "POST", "/open", { ...OPEN, ...bad })).toEqual({ status: 400, body: "invalid pane request" });
    }
    expect(calls).toEqual([]);
});

test("answers and ends only the panes it opened", async () => {
    const { door, calls } = await open((args) => {
        if (args[0] === "display-message") {
            return args.at(-1) === "#{@intentic_owner}" ? missing() : args.at(-1) === "#{pane_dead}" ? "0\n" : "999999999\n";
        }
        return args[0] === "list-panes" ? "" : "%7\n";
    });
    door.attach(domain);
    await ask(door.socket, "POST", "/open", OPEN);
    expect(await ask(door.socket, "GET", "/dead?pane=%253")).toEqual({ status: 404, body: "not a pane this domain opened" });
    expect(await ask(door.socket, "POST", "/kill", { pane: "%3" })).toEqual({ status: 404, body: "not a pane this domain opened" });
    expect(await ask(door.socket, "GET", "/dead?pane=%257")).toEqual({ status: 200, body: "0" });
    calls.length = 0;
    expect(await ask(door.socket, "POST", "/kill", { pane: "%7" })).toEqual({ status: 200, body: "killed" });
    expect(calls.map((call) => call.args)).toEqual([
        ["display-message", "-p", "-t", "%7", "#{pane_pid}"],
        ["kill-window", "-t", "%7"],
    ]);
    expect(await ask(door.socket, "GET", "/dead?pane=%257")).toEqual({ status: 404, body: "not a pane this domain opened" });
});

test("close stops answering and removes the socket", async () => {
    const { door } = await open(() => "%1\n");
    await door.close();
    await expect(stat(door.socket)).rejects.toMatchObject({ code: "ENOENT" });
    await door.close();
});
