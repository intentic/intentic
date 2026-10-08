import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_STATE } from "../sessions/session-store.js";
import { agentSshConf, parseGitConfigList, provisionAgentHome, renderAgentGitconfig, RESTORE_MOUNT_POINTS } from "./agent-home.js";

// Real temp trees: a HOME as the agent can leave it, and a host dir the daemon's ssh aliases live in. Owner is this
// process's own uid, since the suite need not run as root.

let base: string;
let home: string;
let hosts: string;
let outside: string;
const owner = process.getuid?.() ?? 0;
const provision = (gitconfig: [string, string][] = []): void =>
    provisionAgentHome({ home, workspaceRoot: "/work", gitconfig, sshHosts: hosts, owner });

beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "agent-home-"));
    home = join(base, "agent-home");
    hosts = join(base, "ssh-hosts");
    outside = join(base, "outside");
    await Promise.all([mkdir(home), mkdir(hosts), mkdir(outside)]);
});
afterEach(async () => {
    await rm(base, { recursive: true, force: true });
});

test("a fresh HOME gets the session store links, retention, the restore mount points, git config and the public ssh halves", async () => {
    await writeFile(join(hosts, "box.conf"), `Host box\n    IdentityFile "${hosts}/box.pub"\n    IdentitiesOnly yes\n`);
    await writeFile(join(hosts, "box.pub"), "ssh-ed25519 AAAA box\n");
    await writeFile(join(hosts, "pw.pass"), "hunter2\n");
    await writeFile(join(hosts, "locked.key"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    provision([["user.name", "Agent Owner"], ["credential.helper", "store"]]);
    for (const name of SESSION_STATE) {
        expect(await readlink(join(home, ".claude", name))).toBe(`/work/.intentic/records/sessions/claude/${name}`);
    }
    expect(JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"))).toEqual({ cleanupPeriodDays: 3650 });
    for (const rel of RESTORE_MOUNT_POINTS) {
        expect((await lstat(join(home, rel))).isDirectory()).toBe(true);
    }
    expect(await readFile(join(home, ".gitconfig"), "utf8")).toBe('[user]\n\tname = "Agent Owner"\n[safe]\n\tdirectory = "*"\n');
    expect(await readFile(join(home, ".ssh", "config"), "utf8")).toBe("Include intentic-hosts/*.conf\n");
    expect((await readdir(join(home, ".ssh", "intentic-hosts"))).toSorted()).toEqual(["box.conf", "box.pub"]);
    expect(await readFile(join(home, ".ssh", "intentic-hosts", "box.conf"), "utf8")).toBe(
        'Host box\n    IdentityFile "/home/agent/.ssh/intentic-hosts/box.pub"\n    IdentitiesOnly yes\n',
    );
});

test("never writes through a link the agent left: each is replaced, and what it pointed at is untouched", async () => {
    const target = join(outside, "target-file");
    await writeFile(target, "keep me\n");
    await symlink(outside, join(home, ".claude"));
    await symlink(target, join(home, ".gitconfig"));
    await mkdir(join(home, ".ssh"));
    await symlink(outside, join(home, ".ssh", "intentic-hosts"));
    await symlink(target, join(home, ".ssh", "config"));
    provision();
    expect((await lstat(join(home, ".claude"))).isDirectory()).toBe(true);
    expect((await lstat(join(home, ".gitconfig"))).isFile()).toBe(true);
    expect((await lstat(join(home, ".ssh", "intentic-hosts"))).isDirectory()).toBe(true);
    expect((await lstat(join(home, ".ssh", "config"))).isFile()).toBe(true);
    expect(await readdir(outside)).toEqual(["target-file"]);
    expect(await readFile(target, "utf8")).toBe("keep me\n");
});

test("replaces a real directory where a store link belongs, keeps the agent's own ssh config lines, and drops stale host files", async () => {
    await mkdir(join(home, ".claude", "projects"), { recursive: true });
    await writeFile(join(home, ".claude", "projects", "planted.jsonl"), "{}\n");
    await mkdir(join(home, ".ssh", "intentic-hosts"), { recursive: true });
    await writeFile(join(home, ".ssh", "config"), "Host mine\n    HostName example.org\n");
    await writeFile(join(home, ".ssh", "intentic-hosts", "gone.conf"), "Host gone\n");
    provision();
    expect(await readlink(join(home, ".claude", "projects"))).toBe("/work/.intentic/records/sessions/claude/projects");
    expect(await readFile(join(home, ".ssh", "config"), "utf8")).toBe("Include intentic-hosts/*.conf\nHost mine\n    HostName example.org\n");
    expect(await readdir(join(home, ".ssh", "intentic-hosts"))).toEqual([]);
});

test("refuses a HOME that is not its expected owner's", () => {
    expect(() => provisionAgentHome({ home, workspaceRoot: "/work", gitconfig: [], sshHosts: hosts, owner: owner + 1 })).toThrow("agent HOME is not root's own on disk");
});

test("the git config keeps identity, rewrites and drivers, drops credentials, includes and ssh commands, and quotes values", () => {
    const entries = parseGitConfigList(
        "user.email\na@b.c\0credential.helper\nstore\0include.path\n/root/.extra\0url.git@github.com:.insteadof\nhttps://github.com/\0core.sshCommand\nssh -i /root/k\0diff.fileq.textconv\nfileq read --plain\0alias.q\necho \"hi\"\\ttab\0core.bare\0",
    );
    expect(renderAgentGitconfig(entries)).toBe(
        [
            "[user]",
            '\temail = "a@b.c"',
            '[url "git@github.com:"]',
            '\tinsteadof = "https://github.com/"',
            '[diff "fileq"]',
            '\ttextconv = "fileq read --plain"',
            "[alias]",
            '\tq = "echo \\"hi\\"\\\\ttab"',
            "[core]",
            '\tbare = "true"',
            "[safe]",
            '\tdirectory = "*"',
            "",
        ].join("\n"),
    );
    expect(agentSshConf('IdentityFile "/root/.ssh/intentic-hosts/a.pub"', "/root/.ssh/intentic-hosts", "/home/agent/.ssh/intentic-hosts")).toBe(
        'IdentityFile "/home/agent/.ssh/intentic-hosts/a.pub"',
    );
});
