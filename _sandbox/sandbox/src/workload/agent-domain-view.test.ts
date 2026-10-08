import { shellQuote } from "@intentic/sandbox-run/quote";
import { MAIN_MOUNT } from "./worktree-paths.js";
import { AGENT_HOME } from "./agent-domain.js";
import {
    buildAgentDomainView, parseSameHostMounts, resolveGitPointer, sameHostAliases, validateAgentOverlayDirectories,
    type AgentGitMetadata, type AgentOverlayDirectory, type PreparedAgentDomainView,
} from "./agent-domain-view.js";

// Pure builder mode: no filesystem, Git subprocess, namespaces, mounts, or dependence on this host's capabilities.
const fixture = (): PreparedAgentDomainView => {
    const historyRoot = "/history";
    const root = "/work";
    const worktree = "/history/worktrees/c1";
    const metadata = (repository: string, gitdir: string, commonDir: string): AgentGitMetadata => ({
        repository, pointer: { path: `${repository}/.git`, kind: "file" }, gitdir, commonDir,
    });
    return {
        plan: { root, worktree, overlays: "/history/overlays/c1", mirrors: ["node_modules", "apps/web/node_modules"], fence: undefined },
        historyRoot, scratch: "/history/agent-domain-abc", homeSource: "/history/agent-home", run: "/history/agent-run/c1", door: "/run/intentic/doors/d1.sock", restores: [],
        mainAliases: ["/backup/work"], worktreeAliases: [worktree, "/turn-alias"],
        historyAliases: [
            { source: historyRoot, target: historyRoot, kind: "directory" },
            { source: historyRoot, target: "/archive/history", kind: "directory" },
        ],
        historyPaths: ["/history/agent-homes", "/history/agent-containers", "/history/agent-run/c1"],
        shared: [".intentic/local", ".intentic/records"], shelf: true, packageStore: true,
        masks: [
            { path: "/work/.intentic/secrets/auth", kind: "directory" },
            { path: "/srv/credential-vault", kind: "directory" },
            { path: "/root", kind: "directory" },
        ],
        git: [
            metadata(root, "/history/gits/root", "/history/gits/root"),
            metadata(`${root}/apps/web`, "/history/gits/web", "/history/gits/web"),
            metadata(worktree, "/history/gits/root/worktrees/c1", "/history/gits/root"),
            metadata(`${worktree}/apps/web`, "/history/gits/web/worktrees/c1", "/history/gits/web"),
        ],
        gitAliases: [],
        endpoints: ["/run/intentic/agent.token", "/run/intentic/room.sock", "/run/intentic/ssh/c-c1.boot.sock"],
        readOnlyMounts: ["/", "/usr", "/opt/sandbox", "/work", "/history", "/run"],
    };
};
const USERNS = "/proc/432/ns/user";
const linesOf = (input = fixture()): string[] => buildAgentDomainView(input).script(USERNS).split("\n");
const plainBind = (source: string, target: string): string => `mount --bind -- ${shellQuote(source)} ${shellQuote(target)}`;
const pinTree = (target: string): string => `mount --rbind -- ${shellQuote(target)} ${shellQuote(target)}`;
const ro = (target: string): string => `mount -o remount,bind,ro -- ${shellQuote(target)}`;
const idmappedTargets = (lines: readonly string[]): string[] => lines.filter((line) => line.startsWith("mount --bind -o ")).map((line) => line.split(" ").at(-1)!);
const staged = (lines: readonly string[], source: string): string => {
    const line = lines.find((entry) => entry.startsWith(plainBind(source, "/history/agent-domain-abc/sources/").slice(0, -1)));
    if (line === undefined) { throw new Error(`Missing stage for ${  source}`); }
    return line.split(" ").at(-1)!.replace("/history/agent-domain-abc", "/run/intentic-view");
};
const upper = (): AgentOverlayDirectory => ({ path: "/history/overlays/c1/node_modules/upper", uid: 1500, gid: 1500, device: 8, inode: 20, kind: "directory" });
const work = (): AgentOverlayDirectory => ({ path: "/history/overlays/c1/node_modules/work", uid: 1500, gid: 1500, device: 8, inode: 21, kind: "directory" });

it("returns the domain view API and only a daemon-owned mount program", () => {
    const view = buildAgentDomainView(fixture());
    expect({ cwd: view.cwd, home: view.home, scratch: view.scratch }).toEqual({ cwd: "/work", home: AGENT_HOME, scratch: "/history/agent-domain-abc" });
    expect(view.script(USERNS).split("\n").slice(0, 4)).toEqual([
        "set -eu", "export PATH=/usr/sbin:/usr/bin:/sbin:/bin", "umask 066", "mount --make-rprivate /",
    ]);
    expect(view.script(USERNS)).not.toContain("unshare");
    expect(view.script(USERNS)).not.toContain("eval");
    expect(view.script(USERNS)).not.toContain("nsenter");
});

it("stages daemon sources before replacing /run or masking any history alias", () => {
    const lines = linesOf();
    const firstRun = "mount -t tmpfs -o uid=0,gid=0,mode=0755,nodev,nosuid tmpfs /run";
    const firstHistory = "mount -t tmpfs -o uid=0,gid=0,mode=0711,nodev,nosuid tmpfs /history";
    expect(lines.slice(4, 6)).toEqual([
        plainBind("/work", "/history/agent-domain-abc/sources/0"),
        plainBind("/history/worktrees/c1", "/history/agent-domain-abc/sources/1"),
    ]);
    expect(lines.filter((line) => [firstRun, "mount --rbind -- /history/agent-domain-abc /run/intentic-view", firstHistory].includes(line))).toEqual([
        firstRun, "mount --rbind -- /history/agent-domain-abc /run/intentic-view", firstHistory,
    ]);
    expect(lines.filter((line) => line.includes("/run/intentic/ssh/c-c1.boot.sock")).slice(0, 1)).toEqual([
        plainBind("/run/intentic/ssh/c-c1.boot.sock", staged(lines, "/run/intentic/ssh/c-c1.boot.sock").replace("/run/intentic-view", "/history/agent-domain-abc")),
    ]);
});

it("idmaps worktree, every reachable alias, HOME, shared state and the package store but not history itself", () => {
    expect(idmappedTargets(linesOf())).toEqual([
        MAIN_MOUNT, "/backup/work", "/work", "/history/worktrees/c1", "/turn-alias", "/archive/history/worktrees/c1",
        "/history/agent-containers", "/archive/history/agent-containers",
        "/history/agent-home", "/archive/history/agent-home", AGENT_HOME,
        "/history/agent-homes", "/archive/history/agent-homes",
        "/history/agent-run/c1", "/archive/history/agent-run/c1", "/tmp",
        "/mnt/intentic-main/.intentic/local", "/backup/work/.intentic/local", "/work/.intentic/local", "/history/worktrees/c1/.intentic/local", "/turn-alias/.intentic/local", "/archive/history/worktrees/c1/.intentic/local",
        "/mnt/intentic-main/.intentic/records", "/backup/work/.intentic/records", "/work/.intentic/records", "/history/worktrees/c1/.intentic/records", "/turn-alias/.intentic/records", "/archive/history/worktrees/c1/.intentic/records",
        "/mnt/intentic-main/refs", "/backup/work/refs", "/work/refs", "/history/worktrees/c1/refs", "/turn-alias/refs", "/archive/history/worktrees/c1/refs",
        "/mnt/intentic-main/.pnpm-store", "/backup/work/.pnpm-store", "/work/.pnpm-store", "/history/worktrees/c1/.pnpm-store", "/turn-alias/.pnpm-store", "/archive/history/worktrees/c1/.pnpm-store",
    ]);
    expect(linesOf().filter((line) => line.includes("X-mount.idmap") && /(?: \/history| \/archive\/history)$/u.test(line))).toEqual([]);
});

it("builds a main-tree domain too, with one writable root and protected Git metadata at each alias", () => {
    const input = fixture();
    const lines = linesOf({
        ...input,
        plan: { ...input.plan, worktree: input.plan.root, mirrors: [] },
        worktreeAliases: [input.plan.root],
        git: input.git.filter((entry) => entry.repository.startsWith(input.plan.root)),
    });
    expect(idmappedTargets(lines).slice(0, 3)).toEqual([MAIN_MOUNT, "/backup/work", "/work"]);
    expect(lines.filter((line) => line.startsWith("mount -o remount,bind,ro") && line.endsWith("/.git"))).toEqual([
        ro("/work/.git"), ro("/backup/work/.git"), ro("/work/apps/web/.git"),
        ro("/mnt/intentic-main/.git"), ro("/backup/work/apps/web/.git"), ro("/mnt/intentic-main/apps/web/.git"),
    ]);
    expect(lines.filter((line) => line.startsWith("mount -t overlay"))).toEqual([]);
    expect(lines.filter((line) => line.startsWith(plainBind("/work", "/history/agent-domain-abc/sources/").slice(0, -1)))).toEqual([
        plainBind("/work", "/history/agent-domain-abc/sources/0"),
    ]);
});

it("restores only the daemon-selected session history child, not the parent or another conversation", () => {
    const lines = linesOf({ ...fixture(), historyPaths: ["/history/sessions/c1", "/history/agent-run/c1"] });
    expect(idmappedTargets(lines).filter((target) => target.includes("/sessions/"))).toEqual([
        "/history/sessions/c1", "/archive/history/sessions/c1",
    ]);
    expect(idmappedTargets(lines).filter((target) => target.endsWith("/sessions"))).toEqual([]);
    expect(lines.filter((line) => line.includes("/sessions/c2"))).toEqual([]);
    expect(() => buildAgentDomainView({ ...fixture(), historyPaths: ["/history/sessions"] })).toThrow("not an agent-accessible history child");
});

it("binds the run directory at its own path and refuses one outside agent-run or left unbound", () => {
    expect(() => buildAgentDomainView({ ...fixture(), run: "/history/agent-home/run" })).toThrow("run directory must be a child of agent-run");
    expect(() => buildAgentDomainView({ ...fixture(), run: "/history/agent-run/c1/nested" })).toThrow("run directory must be a child of agent-run");
    expect(() => buildAgentDomainView({ ...fixture(), historyPaths: ["/history/agent-homes"] })).toThrow("the run directory must be bound at its own path");
});

it("keeps the image root unmapped and read-only, with its own shm, a disk-backed tmp and private runtime/cache dirs", () => {
    const lines = linesOf();
    const shm = "if [ -d /dev/shm ]; then mount -t tmpfs -o uid=1500,gid=1500,mode=1777,nodev,nosuid,noexec tmpfs /dev/shm; fi";
    const tmp = `mount --bind -o X-mount.idmap=${USERNS} -- ${staged(lines, `${fixture().run}/tmp`)} /tmp`;
    expect(lines.filter((line) => [pinTree("/usr"), ro("/usr"), pinTree("/opt/sandbox"), ro("/opt/sandbox"), pinTree("/"), ro("/"), shm, tmp].includes(line))).toEqual([
        ro("/opt/sandbox"), ro("/usr"), ro("/"), shm, tmp,
    ]);
    // A copy stacked over "/" would hide every later mount from an entrant, whose setns lands on the topmost root.
    expect(lines.filter((line) => line.startsWith("mount --rbind -- / "))).toEqual([]);
    expect(lines.filter((line) => line.includes("tmpfs /tmp"))).toEqual([]);
    expect(lines.slice(-7)).toEqual([
        "mkdir -p /run/user/0 /run/agent/cache /run/intentic/ssh /run/intentic-domain",
        "chown 1500:1500 /run/user/0 /run/agent /run/agent/cache",
        "chmod 0700 /run/user/0 /run/agent /run/agent/cache",
        "chown 0:0 /run/user /run/intentic /run/intentic/ssh /run/intentic-domain",
        "chmod 0711 /run/user /run/intentic /run/intentic/ssh",
        "chmod 0700 /run/intentic-domain",
        ro("/run/intentic-view"),
    ]);
});

it("only exposes the fixed agent endpoints and one conversation socket, without idmapping /run/intentic", () => {
    const lines = linesOf();
    expect(lines.filter((line) => line.startsWith("mount --bind") && / \/run\/intentic\/[^ ]+$/u.test(line)).map((line) => line.split(" ").at(-1))).toEqual([
        "/run/intentic/agent.token", "/run/intentic/room.sock", "/run/intentic/ssh/c-c1.boot.sock", "/run/intentic/panes.sock",
    ]);
    expect(lines).toContain(plainBind(staged(lines, "/run/intentic/doors/d1.sock"), "/run/intentic/panes.sock"));
    expect(() => buildAgentDomainView({ ...fixture(), door: "/run/intentic/ssh/owner.sock" })).toThrow("pane door outside /run/intentic/doors");
    expect(() => buildAgentDomainView({ ...fixture(), door: "/run/intentic/doors/../owner.sock" })).toThrow("absolute clean path");
    expect(() => buildAgentDomainView({ ...fixture(), door: "/history/agent-run/c1/panes.sock" })).toThrow("pane door outside /run/intentic/doors");
    expect(lines.join("\n")).not.toContain("owner.sock");
    expect(lines.join("\n")).not.toContain("netd.sock");
    expect(idmappedTargets(lines).filter((target) => target.startsWith("/run/"))).toEqual([]);
    expect(() => buildAgentDomainView({ ...fixture(), endpoints: [...fixture().endpoints, "/run/intentic/ssh/owner.sock"] })).toThrow("unapproved runtime endpoint");
    expect(() => buildAgentDomainView({ ...fixture(), endpoints: [...fixture().endpoints, "/run/intentic/netd.sock"] })).toThrow("unapproved runtime endpoint");
    expect(() => buildAgentDomainView({ ...fixture(), endpoints: fixture().endpoints.slice(1) })).toThrow("missing runtime endpoint");
});

it("masks secrets and identity at main, worktree, workspace and independent aliases, and coalesces nested masks", () => {
    const lines = linesOf();
    expect(lines.filter((line) => line.startsWith("mount --bind -- /run/intentic-view/empty-directory ")).map((line) => line.split(" ").at(-1))).toEqual([
        "/root", "/srv/credential-vault",
        "/work/.intentic/secrets", "/work/.intentic/identity",
        "/turn-alias/.intentic/secrets", "/backup/work/.intentic/secrets", "/turn-alias/.intentic/identity", "/backup/work/.intentic/identity",
        "/mnt/intentic-main/.intentic/secrets", "/mnt/intentic-main/.intentic/identity",
        "/history/worktrees/c1/.intentic/secrets", "/history/worktrees/c1/.intentic/identity",
        "/archive/history/worktrees/c1/.intentic/secrets", "/archive/history/worktrees/c1/.intentic/identity",
    ]);
    expect(lines.filter((line) => line.includes("empty-directory") && line.includes("/secrets/auth"))).toEqual([]);
    expect(lines.filter((line) => line.endsWith(" /work/.intentic") && line.startsWith("mount --rbind"))).toEqual([pinTree("/work/.intentic")]);
    expect(lines.filter((line) => line.endsWith(" /turn-alias/.intentic") && line.startsWith("mount --rbind"))).toEqual([pinTree("/turn-alias/.intentic")]);
});

it("protects auth/control data inside agent HOME at every alias while omitting redundant masks of already-empty history, tmp and run", () => {
    const input = fixture();
    const lines = linesOf({ ...input, masks: [
        ...input.masks,
        { path: "/history/agent-home/private-auth", kind: "directory" },
        { path: "/history/daemon-auth", kind: "directory" },
        { path: "/tmp/private-auth", kind: "directory" },
        { path: "/run/private-auth", kind: "directory" },
        { path: "/work/control.sock", kind: "file" },
    ] });
    expect(lines.filter((line) => line.includes("empty-directory") && line.endsWith("/private-auth"))).toEqual([
        plainBind("/run/intentic-view/empty-directory", "/home/agent/private-auth"),
        plainBind("/run/intentic-view/empty-directory", "/history/agent-home/private-auth"),
        plainBind("/run/intentic-view/empty-directory", "/archive/history/agent-home/private-auth"),
    ]);
    expect(lines.filter((line) => line.includes("empty-directory") && line.includes("daemon-auth"))).toEqual([]);
    expect(lines.filter((line) => line.startsWith("mount --bind -- /run/intentic-view/empty-file ")).map((line) => line.split(" ").at(-1))).toEqual([
        "/work/control.sock", "/turn-alias/control.sock", "/backup/work/control.sock", "/mnt/intentic-main/control.sock", "/history/worktrees/c1/control.sock", "/archive/history/worktrees/c1/control.sock",
    ]);
});

it("keeps refs read-only at all aliases before adding any overlays", () => {
    const lines = linesOf();
    expect(lines.filter((line) => line.startsWith("mount -o remount,bind,ro") && line.endsWith("/refs"))).toEqual([
        ro("/mnt/intentic-main/refs"), ro("/backup/work/refs"), ro("/work/refs"), ro("/history/worktrees/c1/refs"), ro("/turn-alias/refs"), ro("/archive/history/worktrees/c1/refs"),
    ]);
    expect(lines.filter((line) => line === ro("/work/refs") || line.startsWith("mount -t overlay"))).toEqual([
        ro("/work/refs"),
        "mount -t overlay intentic-agent-modules -o lowerdir=/mnt/intentic-main/node_modules,upperdir=/run/intentic-view/sources/23,workdir=/run/intentic-view/sources/24 -- /work/node_modules",
        "mount -t overlay intentic-agent-modules -o lowerdir=/mnt/intentic-main/apps/web/node_modules,upperdir=/run/intentic-view/sources/25,workdir=/run/intentic-view/sources/26 -- /work/apps/web/node_modules",
    ]);
});

it("uses an idmapped lower but plain on-disk-1500 upper/work binds, never idmaps an overlay", () => {
    const lines = linesOf();
    expect(lines.filter((line) => /\/overlays\/c1\/.*\/(upper|work) /u.test(line))).toEqual([
        plainBind("/history/overlays/c1/node_modules/upper", "/history/agent-domain-abc/sources/23"),
        plainBind("/history/overlays/c1/node_modules/work", "/history/agent-domain-abc/sources/24"),
        plainBind("/history/overlays/c1/apps%2Fweb%2Fnode_modules/upper", "/history/agent-domain-abc/sources/25"),
        plainBind("/history/overlays/c1/apps%2Fweb%2Fnode_modules/work", "/history/agent-domain-abc/sources/26"),
    ]);
    expect(lines.filter((line) => line.startsWith("mount --bind -o") && /sources\/(23|24|25|26) /u.test(line))).toEqual([]);
    expect(lines.filter((line) => line.startsWith("mount -t overlay") && line.includes("idmap"))).toEqual([]);
    expect(lines.filter((line) => /mount --bind -- \/work\/node_modules /u.test(line))).toEqual([
        plainBind("/work/node_modules", "/history/worktrees/c1/node_modules"), plainBind("/work/node_modules", "/turn-alias/node_modules"), plainBind("/work/node_modules", "/archive/history/worktrees/c1/node_modules"),
    ]);
});

it("pins every nested repository ancestor and protects all pointers and entire backing metadata trees read-only", () => {
    const lines = linesOf();
    const pins = [pinTree("/work/apps"), pinTree("/work/apps/web")];
    expect(lines.filter((line) => pins.includes(line) || line.endsWith(" /work/apps/web/.git"))).toEqual([
        ...pins, plainBind(staged(lines, "/history/worktrees/c1/apps/web/.git"), "/work/apps/web/.git"), ro("/work/apps/web/.git"),
    ]);
    expect(lines.filter((line) => line.startsWith("mount -o remount,bind,ro") && line.endsWith("/.git"))).toEqual([
        ro("/work/.git"), ro("/turn-alias/.git"), ro("/backup/work/.git"), ro("/work/apps/web/.git"),
        ro("/mnt/intentic-main/.git"), ro("/turn-alias/apps/web/.git"), ro("/backup/work/apps/web/.git"),
        ro("/history/worktrees/c1/.git"), ro("/mnt/intentic-main/apps/web/.git"),
        ro("/archive/history/worktrees/c1/.git"), ro("/history/worktrees/c1/apps/web/.git"), ro("/archive/history/worktrees/c1/apps/web/.git"),
    ]);
    expect(lines.filter((line) => line.startsWith(": >"))).toEqual([
        ": > /run/intentic/agent.token", ": > /run/intentic/room.sock", ": > /run/intentic/ssh/c-c1.boot.sock", ": > /run/intentic/panes.sock",
    ]);
    expect(lines.filter((line) => line.startsWith(": >") && line.includes("/sources/"))).toEqual([]);
    expect(lines.filter((line) => line.startsWith(": >") && line.endsWith("/.git"))).toEqual([]);
    expect(lines.filter((line) => [ro("/history/gits/root"), ro("/history/gits/web"), ro("/archive/history/gits/root"), ro("/archive/history/gits/web"), ro("/history/gits/root/worktrees/c1"), ro("/history/gits/web/worktrees/c1")].includes(line))).toEqual([
        ro("/history/gits/web"), ro("/history/gits/root"), ro("/archive/history/gits/web"), ro("/archive/history/gits/root"),
        ro("/history/gits/web/worktrees/c1"), ro("/history/gits/root/worktrees/c1"),
    ]);
    expect(idmappedTargets(lines).filter((target) => target.includes("/gits/") || target.endsWith("/.git"))).toEqual([]);
});

it("also protects individually bind-aliased Git config files, rather than relying on a read-only common dir elsewhere", () => {
    const input = fixture();
    const lines = linesOf({ ...input, gitAliases: [{ source: "/history/gits/root/config", target: "/git-config-alias", kind: "file" }] });
    expect(lines.filter((line) => line.endsWith(" /git-config-alias"))).toEqual([
        plainBind(staged(lines, "/history/gits/root/config"), "/git-config-alias"), ro("/git-config-alias"),
    ]);
});

it("rejects absolute-path normalization, mirror traversal and kernel overlay-option delimiters", () => {
    for (const rel of ["../escape", "apps/../../escape", "/node_modules", "apps//node_modules", "apps/./node_modules", "node_modules/", "a,b", "a:b", "a\nnode_modules", ".git/hooks", ".intentic/secrets", "refs", ".pnpm-store"]) {
        expect(() => buildAgentDomainView({ ...fixture(), plan: { ...fixture().plan, mirrors: [rel] } })).toThrow();
    }
    for (const overlays of ["/history/overlays/a,b", "/history/overlays/a:b", "/history/../overlays", "relative", "/work/overlays", "/history/worktrees/c1/overlays", "/mnt/intentic-domain-lease/overlays"]) {
        expect(() => buildAgentDomainView({ ...fixture(), plan: { ...fixture().plan, overlays } })).toThrow();
    }
    expect(() => buildAgentDomainView({ ...fixture(), scratch: "/history/agent-domain-abc/" })).toThrow("absolute clean path");
});

it("rejects auth/alias/mask conflicts, fenced plans, daemon history and hidden init leases instead of degrading", () => {
    for (const mask of ["/", "/work", "/history/agent-home", "/history/gits/root", "/run/intentic", "/mnt/intentic-domain-lease", "/run/intentic-domain"]) {
        expect(() => buildAgentDomainView({ ...fixture(), masks: [{ path: mask, kind: "directory" }] })).toThrow();
    }
    expect(() => buildAgentDomainView({ ...fixture(), historyPaths: ["/history/logs"] })).toThrow("not an agent-accessible history child");
    expect(() => buildAgentDomainView({ ...fixture(), historyPaths: ["/history/ssh-host-keys"] })).toThrow("not an agent-accessible history child");
    expect(() => buildAgentDomainView({ ...fixture(), historyPaths: ["/history/local-cert"] })).toThrow("not an agent-accessible history child");
    expect(() => buildAgentDomainView({ ...fixture(), mainAliases: ["/turn-alias"] })).toThrow("main/worktree aliases overlap");
    expect(() => buildAgentDomainView({ ...fixture(), worktreeAliases: ["/work/alias"] })).toThrow("nested workspace aliases");
    expect(() => buildAgentDomainView({ ...fixture(), plan: { ...fixture().plan, fence: { folders: [], hidden: [], sessions: "/history/sessions/c1", gitPointers: [""] } } })).toThrow("fenced plans");
    expect(() => buildAgentDomainView({ ...fixture(), git: fixture().git.slice(1) })).toThrow("missing root Git metadata");
});

it("leaves the parent's root-owned lease stage untouched and never idmaps the init lease", () => {
    const lines = linesOf({ ...fixture(), readOnlyMounts: [...fixture().readOnlyMounts, "/mnt/intentic-domain-lease"] });
    expect(lines.filter((line) => line.startsWith("mount") && line.includes("intentic-domain"))).toEqual([]);
    expect(lines.filter((line) => line.endsWith(" /run/intentic-domain"))).toEqual([
        "mkdir -p /run/user/0 /run/agent/cache /run/intentic/ssh /run/intentic-domain",
        "chown 0:0 /run/user /run/intentic /run/intentic/ssh /run/intentic-domain",
        "chmod 0700 /run/intentic-domain",
    ]);
});

it("quotes shell metacharacters as data, and accepts only an explicit proc userns idmap handle", () => {
    const view = buildAgentDomainView({ ...fixture(), scratch: "/history/agent-domain-'$(touch nope)'" });
    expect(view.script(USERNS)).toContain("mount --rbind -- '/history/agent-domain-'\\''$(touch nope)'\\''' /run/intentic-view");
    for (const namespace of ["/proc/self/ns/user", "/proc/0/ns/user", "/proc/432/ns/mnt", "u:1500:0:1", "/proc/432/ns/user; false", "/tmp/userns"]) {
        expect(() => view.script(namespace)).toThrow("daemon-held");
    }
});

it("validates overlay directory ownership, sibling/same-fs layout, no symlinks and empty work dirs independently of mount availability", () => {
    expect(() => validateAgentOverlayDirectories(upper(), work(), true)).not.toThrow();
    for (const value of [{ ...upper(), uid: 0 }, { ...upper(), gid: 0 }, { ...upper(), kind: "symlink" as const }, { ...upper(), kind: "file" as const }, { ...upper(), path: work().path }, { ...upper(), path: "/history/overlays/c1/other/upper" }, { ...upper(), path: "/history/overlays/c1/x,y/upper" }]) {
        expect(() => validateAgentOverlayDirectories(value, work(), true)).toThrow();
    }
    expect(() => validateAgentOverlayDirectories(upper(), { ...work(), device: 9 }, true)).toThrow("unsafe overlay");
    expect(() => validateAgentOverlayDirectories(upper(), { ...work(), inode: 20 }, true)).toThrow("unsafe overlay");
    expect(() => validateAgentOverlayDirectories(upper(), work(), false)).toThrow("unsafe overlay");
});

it("parses Git pointers without executing Git and rejects missing, multiline and unsafe paths", () => {
    expect(resolveGitPointer("gitdir: /history/gits/root/worktrees/c1\n", "/work/.git")).toBe("/history/gits/root/worktrees/c1");
    expect(resolveGitPointer("gitdir: admin\n", "/work/repo/.git")).toBe("/work/repo/admin");
    for (const value of ["", "gitdir: \n", "gitdir: /history/gits/root\ninclude: evil\n", "gitdir: /history/../auth", "gitdir: ../auth", "gitdir: admin/../auth", "gitdir: /history//gits", "gitdir: /history/gits\u0000"]) {
        expect(() => resolveGitPointer(value, "/work/.git")).toThrow();
    }
    expect(() => resolveGitPointer("gitdir: /history/gits/root", "relative/.git")).toThrow("absolute clean path");
});

it("uses same-host mount identity to enumerate complete and descendant aliases, including separately mounted secrets", () => {
    const mounts = [
        { device: "0:1", root: "/", target: "/" },
        { device: "8:1", root: "/workspace", target: "/work" },
        { device: "8:1", root: "/workspace", target: "/backup/work" },
        { device: "8:1", root: "/workspace/.intentic/secrets/keys", target: "/leaked-keys" },
        { device: "8:2", root: "/vault", target: "/work/.intentic/secrets/external" },
        { device: "8:2", root: "/vault", target: "/external-vault-alias" },
    ];
    expect(sameHostAliases("/work/.intentic/secrets", mounts, true)).toEqual([
        { source: "/work/.intentic/secrets", target: "/work/.intentic/secrets" },
        { source: "/work/.intentic/secrets", target: "/backup/work/.intentic/secrets" },
        { source: "/work/.intentic/secrets/keys", target: "/leaked-keys" },
        { source: "/work/.intentic/secrets/external", target: "/external-vault-alias" },
    ]);
    expect(sameHostAliases("/work", mounts, false)).toEqual([
        { source: "/work", target: "/work" }, { source: "/work", target: "/backup/work" },
    ]);
    expect(sameHostAliases("/work/.intentic/secrets", [...mounts, { device: "8:3", root: "/", target: "/backup/work/.intentic" }], false)).toEqual([
        { source: "/work/.intentic/secrets", target: "/work/.intentic/secrets" },
    ]);
});

it("decodes mountinfo escapes, rejects malformed/unclean aliases and never treats another device as the same backing tree", () => {
    const mounts = parseSameHostMounts("1 0 0:1 / / rw - overlay overlay rw\n2 1 8:1 /workspace /work rw - ext4 disk rw\n3 1 8:1 /workspace /backup\\040work rw - ext4 disk rw\n4 1 8:2 /workspace /unrelated rw - ext4 disk rw\n");
    expect(sameHostAliases("/work", mounts, false)).toEqual([
        { source: "/work", target: "/work" }, { source: "/work", target: "/backup work" },
    ]);
    expect(() => parseSameHostMounts("malformed")).toThrow("invalid mountinfo");
    expect(() => parseSameHostMounts("1 0 0:1 / /x/../y rw - ext4 disk rw")).toThrow("absolute clean path");
    expect(() => parseSameHostMounts("1 0 0:1 / /x\\012y rw - ext4 disk rw")).toThrow("absolute clean path");
    expect(() => sameHostAliases("/work", [], false)).toThrow("no mount describes");
});

it("restores only the allowed parts of the daemon's HOME, read-only and unmapped, over a tmpfs that then turns read-only", () => {
    const lines = linesOf({ ...fixture(), restores: [".claude/skills", ".cache/ms-playwright"] });
    const skills = staged(lines, "/root/.claude/skills");
    const browsers = staged(lines, "/root/.cache/ms-playwright");
    const rootTmpfs = "mount -t tmpfs -o uid=0,gid=0,mode=0755,size=1m,nodev,nosuid tmpfs /root";
    const relevant = lines.filter((line) => line.endsWith(" /root") || line.includes("/.claude/skills") || line.includes("ms-playwright"));
    expect(relevant.filter((line) => !line.startsWith("mount --bind -- /root/"))).toEqual([
        rootTmpfs,
        "mkdir -p /root/.claude/skills", plainBind(skills, "/root/.claude/skills"), ro("/root/.claude/skills"),
        "mount -o remount,ro -- /root",
        plainBind(skills, `${AGENT_HOME}/.claude/skills`), ro(`${AGENT_HOME}/.claude/skills`),
        plainBind(browsers, `${AGENT_HOME}/.cache/ms-playwright`), ro(`${AGENT_HOME}/.cache/ms-playwright`),
    ]);
    expect(lines).not.toContain(plainBind("/run/intentic-view/empty-directory", "/root"));
    expect(idmappedTargets(lines).filter((target) => target.includes("skills") || target.includes("playwright"))).toEqual([]);
    expect(() => buildAgentDomainView({ ...fixture(), restores: [".ssh"] })).toThrow("not a restorable path of the daemon's HOME: .ssh");
    expect(() => buildAgentDomainView({ ...fixture(), restores: [".claude/skills"], masks: fixture().masks.filter((mask) => mask.path !== "/root") }))
        .toThrow("restores under the daemon's HOME need that HOME masked");
});
