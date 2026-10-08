import { agentEntrant, forgetAgentDomainEntry, forgetNamespaceEntry, forgetSandboxEntry, nsenterArgv, nsenterPrefix, registerAgentDomainEntry, registerMountEntry, registerSandboxEntry } from "./namespace-entry.js";
import { agentUsernsArgv } from "./domain/agent-domain.js";

const domain = { userNamespace: "/proc/412/ns/user", home: "/home/agent" };

test("the map contains agent uid and subordinate ids, never daemon uid zero", () => {
    expect(agentUsernsArgv()).toEqual([
        "--user", "--map-users=0:1500:1", "--map-users=1:100000:65536",
        "--map-groups=0:1500:1", "--map-groups=1:100000:65536",
        "sh", "-c", "printf '%s\\n' agent-user-ready; exec sleep infinity",
    ]);
});

test("every domain entrant joins the explicit userns and the mount/PID anchor before running its program", () => {
    const reference = registerAgentDomainEntry(410, domain);
    try {
        const expected = {
            command: "nsenter", args: [
                "--target=410", "--user=/proc/412/ns/user", "--mount", "--pid", "--setuid=0", "--setgid=0",
                "--wdns=/work/a b", "--", "setpriv", "--no-new-privs", "env", "-u", "PWD", "-u", "OLDPWD",
                "HOME=/home/agent", "USER=agent", "LOGNAME=agent", "XDG_RUNTIME_DIR=/run/user/0", "node", "--", "an argument",
            ],
        };
        expect(nsenterArgv(410, "/work/a b", "node", ["--", "an argument"])).toEqual(expected);
        expect(nsenterArgv(reference, "/work/a b", "node", ["--", "an argument"])).toEqual(expected);
        expect(nsenterPrefix(410, "/work/a b")).toBe(
            "nsenter --target=410 --user=/proc/412/ns/user --mount --pid --setuid=0 --setgid=0 '--wdns=/work/a b' -- setpriv --no-new-privs env -u PWD -u OLDPWD HOME=/home/agent USER=agent LOGNAME=agent XDG_RUNTIME_DIR=/run/user/0 ",
        );
        expect(nsenterPrefix(reference, "/work/a b")).toBe(
            "nsenter --target=410 --user=/proc/412/ns/user --mount --pid --setuid=0 --setgid=0 '--wdns=/work/a b' -- setpriv --no-new-privs env -u PWD -u OLDPWD HOME=/home/agent USER=agent LOGNAME=agent XDG_RUNTIME_DIR=/run/user/0 ",
        );
    } finally { forgetNamespaceEntry(reference); }
});

test("a disposed domain is never silently entered as a plain root mount namespace", () => {
    const reference = registerAgentDomainEntry(420, domain);
    forgetAgentDomainEntry(420);
    expect(() => agentEntrant(420, "/work", "true", [])).toThrow("not registered");
    expect(() => nsenterArgv(420, "/work", "true", [])).toThrow("not registered");
    expect(() => nsenterPrefix(420, "/work")).toThrow("not registered");
    expect(() => agentEntrant(reference, "/work", "true", [])).toThrow("reference is not registered");
});

test("root mode and fenced entry keep their original argv", () => {
    expect(nsenterArgv(430, "/work", "true", [])).toEqual({ command: "nsenter", args: [
        "--mount=/proc/430/ns/mnt", "--wdns=/work", "--", "env", "-u", "PWD", "-u", "OLDPWD", "true",
    ] });
    registerSandboxEntry(440, { uid: 1000, gid: 1000 });
    try {
        expect(nsenterArgv(440, "/work", "true", [])).toEqual({ command: "nsenter", args: [
            "--target=440", "--user", "--mount", "--pid", "--uts", "--ipc", "--setuid=1000", "--setgid=1000",
            "--wdns=/work", "--", "setpriv", "--no-new-privs", "env", "-u", "PWD", "-u", "OLDPWD", "true",
        ] });
        expect(() => registerAgentDomainEntry(440, domain)).toThrow("already registered");
    } finally { forgetSandboxEntry(440); }
});

test("a fresh root generation can reuse a PID without reviving a retired domain request", () => {
    const old = registerAgentDomainEntry(450, domain);
    forgetNamespaceEntry(old);
    const fresh = registerMountEntry(450);
    try {
        expect(nsenterArgv(fresh, "/work", "true", [])).toEqual({ command: "nsenter", args: [
            "--mount=/proc/450/ns/mnt", "--wdns=/work", "--", "env", "-u", "PWD", "-u", "OLDPWD", "true",
        ] });
        expect(nsenterPrefix(fresh, "/work")).toBe("nsenter --mount=/proc/450/ns/mnt --wdns=/work -- env -u PWD -u OLDPWD ");
        expect(() => nsenterArgv(old, "/work", "true", [])).toThrow("reference is not registered");
        expect(() => nsenterPrefix(old, "/work")).toThrow("reference is not registered");
        expect(() => nsenterArgv(450, "/work", "true", [])).toThrow("not registered");
        expect(() => agentEntrant(fresh, "/work", "true", [])).toThrow("agent domain anchor 450 is not registered");
    } finally { forgetNamespaceEntry(fresh); }
    expect(() => nsenterArgv(fresh, "/work", "true", [])).toThrow("reference is not registered");
    expect(() => nsenterArgv(450, "/work", "true", [])).toThrow("not registered");
});

test("a new domain generation does not revive an old reference or let its disposer retire the replacement", () => {
    const old = registerAgentDomainEntry(460, domain);
    forgetNamespaceEntry(old);
    const fresh = registerAgentDomainEntry(460, { ...domain, userNamespace: "/proc/462/ns/user" });
    try {
        forgetNamespaceEntry(old);
        expect(() => agentEntrant(old, "/work", "true", [])).toThrow("reference is not registered");
        expect(agentEntrant(fresh, "/work", "true", []).args.slice(0, 2)).toEqual(["--target=460", "--user=/proc/462/ns/user"]);
    } finally { forgetNamespaceEntry(fresh); }
});

test("lookalike references cannot claim an entry and mutation of the registration input cannot change its authority", () => {
    const input = { ...domain };
    const reference = registerAgentDomainEntry(470, input);
    try {
        input.userNamespace = "/proc/other/ns/user";
        input.home = "/root";
        expect(Object.isFrozen(reference)).toBe(true);
        expect(() => nsenterArgv({ pid: 470 }, "/work", "true", [])).toThrow("reference is not registered");
        expect(() => nsenterPrefix({ pid: 470 }, "/work")).toThrow("reference is not registered");
        expect(agentEntrant(reference, "/work", "true", []).args).toEqual([
            "--target=470", "--user=/proc/412/ns/user", "--mount", "--pid", "--setuid=0", "--setgid=0",
            "--wdns=/work", "--", "setpriv", "--no-new-privs", "env", "-u", "PWD", "-u", "OLDPWD",
            "HOME=/home/agent", "USER=agent", "LOGNAME=agent", "XDG_RUNTIME_DIR=/run/user/0", "true",
        ]);
    } finally { forgetNamespaceEntry(reference); }
});

test("fenced PID reuse requires the issued generation too, and cannot clear a retired domain tombstone", () => {
    forgetNamespaceEntry(registerAgentDomainEntry(480, domain));
    const fenced = registerSandboxEntry(480, { uid: 1000, gid: 1000 });
    try {
        expect(nsenterArgv(fenced, "/work", "true", [])).toEqual({ command: "nsenter", args: [
            "--target=480", "--user", "--mount", "--pid", "--uts", "--ipc", "--setuid=1000", "--setgid=1000",
            "--wdns=/work", "--", "setpriv", "--no-new-privs", "env", "-u", "PWD", "-u", "OLDPWD", "true",
        ] });
        expect(() => nsenterArgv(480, "/work", "true", [])).toThrow("not registered");
    } finally { forgetNamespaceEntry(fenced); }
    expect(() => nsenterArgv(fenced, "/work", "true", [])).toThrow("reference is not registered");
    expect(() => nsenterArgv(480, "/work", "true", [])).toThrow("not registered");
});

test("an active root reference cannot be replaced by another kind without retiring it first", () => {
    const root = registerMountEntry(490);
    try {
        expect(() => registerMountEntry(490)).toThrow("already registered");
        expect(() => registerAgentDomainEntry(490, domain)).toThrow("already registered");
        expect(() => registerSandboxEntry(490, { uid: 1000, gid: 1000 })).toThrow("already registered");
    } finally { forgetNamespaceEntry(root); }
    const fresh = registerAgentDomainEntry(490, domain);
    try {
        expect(() => nsenterArgv(root, "/work", "true", [])).toThrow("reference is not registered");
        expect(() => registerMountEntry(490)).toThrow("already registered");
        expect(agentEntrant(fresh, "/work", "true", []).args.slice(0, 2)).toEqual(["--target=490", "--user=/proc/412/ns/user"]);
    } finally { forgetNamespaceEntry(fresh); }
});
