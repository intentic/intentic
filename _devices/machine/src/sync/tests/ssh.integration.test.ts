import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REFERENCE_DIR, STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";

import type { Pairing } from "../config.js";
import {
    convergePlan,
    mutagenCreateArgs,
    sameEnds,
    sessionMatchesSpec,
    sessionName,
    sessionSpec,
    sessionSpecs,
    surplusSessions,
    type SyncSessionSpec,
} from "../mutagen.js";
import { ignoreMatcher } from "../residue.js";
import {
    BACKUP_IGNORES,
    IGNORES,
    ignoresFor,
    INCLUDE_MARKER,
    mutagenSshPath,
    pairingSshConfig,
    PROJECT_IGNORES,
    resolvedEndpoint,
    sanitizeId,
    sshAlias,
    sshConfigBlock,
    stripManagedIncludes,
} from "../ssh.js";
import { syncSshPort } from "../tunnel.js";

describe("id sanitization", () => {
    it("keeps only alias-safe chars and trims stray dashes", () => {
        expect(sanitizeId("sandbox-abc.example.dev")).toBe("sandbox-abc-example-dev");
        expect(sanitizeId("--weird__host--")).toBe("weird-host");
    });
    it("derives stable alias + session names", () => {
        expect(sshAlias("sandbox-abc.example.dev")).toBe("intentic-sync-sandbox-abc-example-dev");
        expect(sessionName("sandbox-abc.example.dev")).toBe("intentic-sandbox-abc-example-dev");
    });
});

describe("sshConfigBlock", () => {
    const block = sshConfigBlock({
        alias: "intentic-sync-x",
        port: 24567,
        identityFile: "/home/u/.intentic/sync/id_ed25519",
        knownHostsFile: "/home/u/.intentic/sync/known_hosts",
    });
    it("points at this machine's own transport port and pins our key + known_hosts", () => {
        expect(block).toContain("Host intentic-sync-x");
        expect(block).toContain("HostName 127.0.0.1");
        expect(block).toContain("Port 24567");
        expect(block).toContain('IdentityFile "/home/u/.intentic/sync/id_ed25519"');
        expect(block).toContain("IdentitiesOnly yes");
        expect(block).toContain('UserKnownHostsFile "/home/u/.intentic/sync/known_hosts"');
    });
    // Every sandbox's transport answers on 127.0.0.1; without an alias, a second sandbox's host key would read as
    // the first one's changed, which ssh refuses.
    it("keys known_hosts by the alias, so two sandboxes on one loopback address never collide", () => {
        expect(block).toContain("HostKeyAlias intentic-sync-x");
    });
    // The alias must be literal: ssh expands no %-tokens in HostKeyAlias, so a `%h` would collapse every sandbox onto
    // one entry, refusing the second pairing onward as a changed host key.
    it("writes the alias literally: a %-token would silently collapse every sandbox onto one known_hosts entry", () => {
        expect(block).not.toContain("%");
        const other = sshConfigBlock({
            alias: "intentic-sync-y",
            port: 24568,
            identityFile: "/home/u/.intentic/sync/id_ed25519",
            knownHostsFile: "/home/u/.intentic/sync/known_hosts",
        });
        expect(other).toContain("HostKeyAlias intentic-sync-y");
    });
    it("no longer routes through a tunnel client: the transport is local", () => {
        expect(block).not.toContain("ProxyCommand");
    });
    it("quotes Windows paths with spaces and converts backslashes (OpenSSH globs paths POSIX-style)", () => {
        const win = sshConfigBlock({
            alias: "intentic-sync-x",
            port: 24567,
            identityFile: "C:\\Users\\First Last\\.intentic\\sync\\id_ed25519",
            knownHostsFile: "C:\\Users\\First Last\\.intentic\\sync\\known_hosts",
        });
        expect(win).toContain('IdentityFile "C:/Users/First Last/.intentic/sync/id_ed25519"');
        expect(win).toContain('UserKnownHostsFile "C:/Users/First Last/.intentic/sync/known_hosts"');
    });
});

// On Windows, Mutagen's bundled Cygwin ssh doesn't treat "C:/Users/..." as absolute; it anchors it under ~/.ssh
// where the include matches nothing and silently reads no config. A relative name is the one spelling every build
// resolves alike.
// Regenerated from the full pairing list, not overwritten, so other paired sandboxes' aliases survive.
describe("pairingSshConfig", () => {
    const pairings = [{ sandboxId: "sandbox-0738cd6b5027.intentic.dev" }, { sandboxId: "sandbox-bce57bb9fe3b.intentic.dev" }];

    it("emits a Host block for every paired sandbox, each on its own transport port", () => {
        const fragment = pairingSshConfig(pairings);
        expect(fragment).toContain(`Host ${sshAlias("sandbox-0738cd6b5027.intentic.dev")}`);
        expect(fragment).toContain(`Port ${syncSshPort("sandbox-0738cd6b5027.intentic.dev")}`);
        expect(fragment).toContain(`Host ${sshAlias("sandbox-bce57bb9fe3b.intentic.dev")}`);
        expect(fragment).toContain(`Port ${syncSshPort("sandbox-bce57bb9fe3b.intentic.dev")}`);
        expect(fragment.match(/^Host /gm)).toHaveLength(2);
    });

    // Two sandboxes sharing a port would silently dial each other's ssh, since both ends authenticate fine; the port
    // is derived per-id.
    it("gives two sandboxes two different ports", () => {
        expect(syncSshPort("sandbox-0738cd6b5027.intentic.dev")).not.toBe(syncSshPort("sandbox-bce57bb9fe3b.intentic.dev"));
    });

    it("is empty when nothing is paired, so unpairing the last sandbox leaves no dangling alias", () => {
        expect(pairingSshConfig([])).toBe("");
    });

    // A pairing reached through Docker rides no ssh, so it gets no alias: one would be a door to a listener never bound.
    it("leaves out a pairing reached through Docker", () => {
        const fragment = pairingSshConfig([...pairings, { sandboxId: "sandbox-local", transport: "docker", container: "intentic-sandbox-sandbox-local" }]);
        expect(fragment.match(/^Host /gm)).toHaveLength(2);
        expect(fragment).not.toContain(sshAlias("sandbox-local"));
    });
});

describe("the managed ssh-config include", () => {
    it("is a bare relative name, never an absolute path", () => {
        expect(INCLUDE_MARKER).toMatch(/^Include [^\s/\\]+$/);
    });

    it("strips every spelling we have ever written, so re-running setup cannot leave two", () => {
        const user = [
            `Include "C:/Users/First Last/.intentic/sync/ssh_config"`,
            "Include /home/u/.intentic/sync/ssh_config",
            // The standalone sync agent's spelling; its file carries Host blocks for the same aliases, and whichever
            // include
            // ssh reads first wins.
            "Include intentic-sync.conf",
            "Include intentic-machine.conf",
            "Host build-box",
            "    HostName 10.0.0.4",
        ].join("\n");
        expect(stripManagedIncludes(user)).toBe("Host build-box\n    HostName 10.0.0.4");
    });

    it("leaves the user's own includes and hosts alone", () => {
        const user = ["Include ~/.ssh/work.conf", "Include /etc/ssh/company", "Host intentic-sync-decoy", "    HostName decoy"].join("\n");
        expect(stripManagedIncludes(user)).toBe(user);
    });
});

describe("mutagenSshPath", () => {
    it("leaves the lookup to PATH on POSIX, as Mutagen does", () => {
        expect(mutagenSshPath("linux", undefined)).toBe("ssh");
        expect(mutagenSshPath("darwin", "")).toBe("ssh");
    });

    it("honours MUTAGEN_SSH_PATH, which overrides the search on every platform", async () => {
        const dir = await mkdtemp(join(tmpdir(), "intentic-ssh-"));
        await writeFile(join(dir, "ssh"), "");
        expect(mutagenSshPath("linux", dir)).toBe(join(dir, "ssh"));
        expect(mutagenSshPath("linux", join(dir, "nothing-here"))).toBe("ssh");
    });
});

// `ssh -G` is ground truth for whether that client read our block; one that missed the include echoes the alias
// back as the hostname.
describe("resolvedEndpoint", () => {
    it("reads the resolved HostName and Port out of `ssh -G`", () => {
        expect(resolvedEndpoint("host intentic-sync-x\nuser root\nhostname 127.0.0.1\nport 24567\n")).toEqual({
            hostname: "127.0.0.1",
            port: 24567,
        });
    });

    // The port makes the check specific: every transport is on 127.0.0.1, so hostname alone could pass on a stale
    // block or a `Host *` pointing at the wrong sandbox.
    it("reads back the alias itself on the default port when the config was invisible", () => {
        expect(resolvedEndpoint("host intentic-sync-x\nhostname intentic-sync-x\nport 22\n")).toEqual({
            hostname: "intentic-sync-x",
            port: 22,
        });
    });

    it("is empty when ssh printed neither", () => {
        expect(resolvedEndpoint("")).toEqual({});
    });
});

const spec: SyncSessionSpec = {
    name: "intentic-x",
    localDir: "/home/u/proj",
    remote: { kind: "ssh", alias: "intentic-sync-x" },
    remoteDir: WORKSPACE_ROOT,
    mode: "two-way-safe",
    ignores: IGNORES,
    from: "local",
    symlinks: "portable",
};

// The same pairing on a Windows PC without Developer Mode, which cannot create a link (symlinks.ts).
const linkless: SyncSessionSpec = { ...spec, symlinks: "ignore" };

// The state backup; every assertion below tests one thing: this runs alpha→beta downhill, and a reversed pair
// would silently overwrite the sandbox's live state with the laptop's.
const backup: SyncSessionSpec = {
    name: "intentic-x-state",
    localDir: "/home/u/proj/.intentic",
    remote: { kind: "ssh", alias: "intentic-sync-x" },
    remoteDir: `${WORKSPACE_ROOT}/.intentic`,
    mode: "one-way-replica",
    ignores: BACKUP_IGNORES,
    from: "sandbox",
    symlinks: "portable",
};

describe("mutagenCreateArgs", () => {
    const args = mutagenCreateArgs(spec, false);
    it("names the session, pins the safe conflict mode, ignores our set, stages neighboring, and orders local→remote", () => {
        expect(args.slice(0, 4)).toEqual(["sync", "create", "--name", "intentic-x"]);
        // Pinned explicitly so a Mutagen default change or a user's global config can't flip it to a clobbering mode.
        expect(args[args.indexOf("--sync-mode") + 1]).toBe("two-way-safe");
        for (const pattern of IGNORES) {
            const at = args.indexOf(pattern);
            expect(args[at - 1]).toBe("--ignore");
        }
        expect(args).toContain("--stage-mode-beta");
        // local dir precedes the remote alias:path
        expect(args.indexOf("/home/u/proj")).toBeLessThan(args.indexOf("intentic-sync-x:/work"));
    });

    // --ignore-vcs matches .git directories only and misses the daemon's pointer files; the bare `.git` pattern
    // covers every shape and level.
    it("does not pass --ignore-vcs, and ignores .git at every level so no git state ever file-syncs", () => {
        expect(args).not.toContain("--ignore-vcs");
        expect(IGNORES).toContain(".git");
        expect(IGNORES).not.toContain("/.git");
    });

    // TWO DIRECTORIES SHARE THE NAME `.intentic`, and only one of them is the sandbox's. The workspace's own state
    // dir is excluded at the root (the `-state` session carries it one way); a REPOSITORY's `.intentic/` is committed
    // content and must travel, or — since the bridge moves git state while file sync moves the files — its tracked
    // files read as deleted in the clone for good. Measured: `intentic/.intentic/checks.json` as a phantom `D` in
    // VS Code that no amount of syncing cleared.
    it("excludes the workspace's state dir at the root, and no repository's own .intentic anywhere", () => {
        expect(IGNORES).toContain(`/${STATE_DIR}`);
        expect(IGNORES).not.toContain(STATE_DIR);
    });

    // `.git` is the opposite case, and the contrast is the point: git state travels by its own protocol at every
    // level, so that pattern must stay depth-matched.
    it("keeps .git depth-matched while the state dir is anchored", () => {
        expect(IGNORES).toContain(".git");
        expect(IGNORES).not.toContain("/.git");
    });

    // The reference shelf is consultation material the rest of the product already skips, and it dwarfs the workspace:
    // left in, file sync spends its scans and its uplink on repositories nobody is editing. Anchored like the state
    // dir, since a repository's own `refs/` is ordinary content that must still travel.
    it("excludes the top-level reference shelf, by the same name the tree and search use", () => {
        expect(IGNORES).toContain(`/${REFERENCE_DIR}`);
        expect(IGNORES).not.toContain(REFERENCE_DIR);
    });

    // The sandbox endpoint has no file watcher, so this interval is the whole latency of a sandbox-side change
    // reaching the device. Beta is the sandbox for the workspace session; the backup below runs the other way.
    it("polls the sandbox side faster than Mutagen's ten-second default", () => {
        expect(args[args.indexOf("--watch-polling-interval-beta") + 1]).toBe("2");
        expect(args).not.toContain("--watch-polling-interval-alpha");
    });

    // WHAT BOTH SIDES GENERATE MUST NEVER BE SYNCED. A tree each end writes for itself is a create-vs-create
    // conflict on every file in it, two-way-safe refuses to pick, and a pairing with standing conflicts propagates
    // nothing at all — measured as 98 of them under one dogfooding machine's `.image-out`.
    it("ignores the trees each side generates for itself, not just the ones git ignores", () => {
        for (const generated of [".image-out", "dist", ".turbo", ".astro", ".cache", "node_modules"]) {
            expect(IGNORES).toContain(generated);
        }
    });

    // A drifted session is recreated, and a recreate must not quietly resume a sync the user paused.
    it("creates pre-paused when asked, with the flag ahead of the endpoint positionals", () => {
        const paused = mutagenCreateArgs(spec, true);
        expect(paused).toContain("--paused");
        expect(paused.indexOf("--paused")).toBeLessThan(paused.indexOf("/home/u/proj"));
    });

    // Pinned even where it is Mutagen's own default, like the sync mode: a user's global config must not be what
    // decides whether a session tries to create links on a device that cannot.
    it("pins the symlink mode, and leaves links out where this device cannot create them", () => {
        expect(args[args.indexOf("--symlink-mode") + 1]).toBe("portable");
        const without = mutagenCreateArgs(linkless, false);
        expect(without[without.indexOf("--symlink-mode") + 1]).toBe("ignore");
        expect(without.indexOf("--symlink-mode")).toBeLessThan(without.indexOf("/home/u/proj"));
    });
});

describe("mutagenCreateArgs: the state backup", () => {
    const args = mutagenCreateArgs(backup, false);

    it("runs one-way from the SANDBOX, so the sandbox's state can never be overwritten by the laptop's copy", () => {
        expect(args[args.indexOf("--sync-mode") + 1]).toBe("one-way-replica");
        // Alpha is the source in a one-way session, and alpha is the first positional.
        expect(args.indexOf(`intentic-sync-x:${WORKSPACE_ROOT}/.intentic`)).toBeLessThan(args.indexOf("/home/u/proj/.intentic"));
    });

    it("lands the copy inside the folder the user already has, not beside it", () => {
        expect(args).toContain("/home/u/proj/.intentic");
    });

    // The same unwatched endpoint as the workspace session, on the other side of this one: polling beta here would
    // speed up the laptop, which already watches for real, and leave the sandbox on ten seconds.
    it("polls the sandbox fast on whichever side of this session it is", () => {
        expect(args[args.indexOf("--watch-polling-interval-alpha") + 1]).toBe("2");
        expect(args).not.toContain("--watch-polling-interval-beta");
    });

    // The backup lands on the same device, so a link in the sandbox's state dir is refused here exactly as one in the
    // workspace would be.
    it("leaves links out on a device that cannot create them, like the workspace session", () => {
        const without = mutagenCreateArgs({ ...backup, symlinks: "ignore" }, false);
        expect(without[without.indexOf("--symlink-mode") + 1]).toBe("ignore");
    });

    it("carries the backup's own ignores, not the workspace session's", () => {
        for (const pattern of BACKUP_IGNORES) {
            expect(args[args.indexOf(pattern) - 1]).toBe("--ignore");
        }
        // The workspace list excludes the state dir wholesale: passing it here would sync nothing at all.
        expect(args).not.toContain(STATE_DIR);
    });

    // Rebuildable bulk and credentials stay in the sandbox; everything a person wrote or that happened comes down.
    // Whole groups are excluded by folder, not an inventory of files.
    it("leaves credentials and rebuildable bulk behind, a folder at a time", () => {
        expect([...BACKUP_IGNORES].toSorted()).toEqual(["/identity/control-tokens.json", "/local", "/records/artifacts/browser", "/secrets"]);
    });

    // `identity` is split: ownership records come down, control tokens don't; collapsing it to a whole-folder
    // exclusion would silently stop backing up the records.
    it("excludes the tokens from identity without excluding identity", () => {
        expect(BACKUP_IGNORES).not.toContain("/identity");
        expect(BACKUP_IGNORES).toContain("/identity/control-tokens.json");
    });

    it("copies down what the sandbox going away would otherwise take with it", () => {
        // Those two folders ARE the backup, so nothing in config may be excluded and nothing in records but the page
        // captures that no longer have a reader; a whole-folder `/records` or `/config` would empty the backup itself.
        for (const pattern of BACKUP_IGNORES) {
            expect([pattern, pattern.startsWith("/config")]).toEqual([pattern, false]);
            expect([pattern, pattern.startsWith("/records") && pattern !== "/records/artifacts/browser"]).toEqual([pattern, false]);
        }
        // The exclusion is one subtree deep inside records, never the tree that holds the owner's own uploads.
        expect(BACKUP_IGNORES).not.toContain("/records/artifacts");
    });
});

// Mutagen freezes config at `sync create`; an upgrade only reaches an existing pairing if drift is noticed and
// the session recreated. This predicate is what notices, including `--ignore-vcs` (vcs: true).
describe("sessionMatchesSpec", () => {
    const live = (ignore: { paths?: string[]; vcs?: boolean }) => ({
        alpha: { path: "/home/u/proj" },
        beta: { host: "intentic-sync-x", path: WORKSPACE_ROOT },
        ignore,
    });

    // WHAT A NAME MAY HOLD IS ONE SESSION. Mutagen lets several share one, and two synchronizers over the same pair
    // of roots flag each other's writes as conflicts: a real machine sat at 2 sessions, 108 conflicts, and nothing
    // moving in either direction while both reported "Watching for changes". Reading the first of them called that
    // converged.
    describe("convergePlan", () => {
        const matching = live({ paths: [...IGNORES] });
        it("keeps exactly one session that matches, and replaces duplicates of it", () => {
            expect(convergePlan([matching], spec)).toBe("keep");
            expect(convergePlan([matching, matching], spec)).toBe("replace");
        });

        it("creates when there is none, and replaces one that drifted", () => {
            expect(convergePlan([], spec)).toBe("create");
            expect(convergePlan([live({ paths: [] })], spec)).toBe("replace");
        });

        // What an upgrade does to a Windows PC without Developer Mode: the session it already had carries links, which
        // that PC fails to create on every cycle, so it is recreated to leave them out.
        it("replaces a session that carries links on a device that cannot create them", () => {
            expect(convergePlan([matching], linkless)).toBe("replace");
            expect(convergePlan([{ ...matching, symlink: { mode: "ignore" } }], linkless)).toBe("keep");
        });
    });

    // THE DUPLICATES ARE RETIRED ONE BY ONE, NOT REPLACED AS A SET. A replacement waits for a settled pair of roots,
    // and two synchronizers on one folder are what keep it from settling, so the old rule could wait forever. Mutagen
    // lists by creation time: the first is the oldest, and its own record of what the two ends agreed on survives.
    describe("surplusSessions", () => {
        const matching = live({ paths: [...IGNORES] });

        it("names every session under the name but the first, by identifier", () => {
            const listed = [
                { ...matching, identifier: "sync_oldest" },
                { ...matching, identifier: "sync_second" },
                { ...matching, identifier: "sync_third" },
            ];
            expect(surplusSessions(listed)).toEqual(["sync_second", "sync_third"]);
        });

        it("has nothing to retire with one session or none", () => {
            expect(surplusSessions([{ ...matching, identifier: "sync_only" }])).toEqual([]);
            expect(surplusSessions([])).toEqual([]);
        });

        // Without an identifier a duplicate cannot be named apart from the one kept: it is left for convergePlan to
        // replace with the rest, as before.
        it("never names a session it cannot tell apart from the one kept", () => {
            expect(surplusSessions([{ ...matching, identifier: "sync_oldest" }, matching])).toEqual([]);
        });
    });

    it("matches a session created by this build", () => {
        expect(sessionMatchesSpec(live({ paths: [...IGNORES] }), spec)).toBe(true);
    });

    it("rejects a session created with Mutagen's VCS ignores on", () => {
        expect(sessionMatchesSpec(live({ paths: [...IGNORES], vcs: true }), spec)).toBe(false);
    });

    it("rejects an ignore set that gained, lost, or reordered a pattern", () => {
        expect(sessionMatchesSpec(live({ paths: [...IGNORES, ".pnpm-store"] }), spec)).toBe(false);
        expect(sessionMatchesSpec(live({ paths: IGNORES.filter((pattern) => pattern !== ".git") }), spec)).toBe(false);
        expect(sessionMatchesSpec(live({ paths: IGNORES.toReversed() }), spec)).toBe(false);
    });

    // Protobuf JSON omits defaults, so "no ignores at all" arrives as a bare {} rather than an empty list.
    it("rejects a session with no ignores at all", () => {
        expect(sessionMatchesSpec(live({}), spec)).toBe(false);
    });

    // Every session made before the mode was pinned carries none, which Mutagen reads as portable. Reading it as drift
    // would recreate every paired device's sessions the first time this build starts.
    it("reads a session with no symlink mode as the portable one it is", () => {
        expect(sessionMatchesSpec({ ...live({ paths: [...IGNORES] }), symlink: {} }, spec)).toBe(true);
        expect(sessionMatchesSpec({ ...live({ paths: [...IGNORES] }), symlink: { mode: "portable" } }, spec)).toBe(true);
        expect(sessionMatchesSpec({ ...live({ paths: [...IGNORES] }), symlink: {} }, linkless)).toBe(false);
    });

    it("rejects a session whose symlink mode is not this device's", () => {
        expect(sessionMatchesSpec({ ...live({ paths: [...IGNORES] }), symlink: { mode: "ignore" } }, spec)).toBe(false);
        expect(sessionMatchesSpec({ ...live({ paths: [...IGNORES] }), symlink: { mode: "posix-raw" } }, linkless)).toBe(false);
        expect(sessionMatchesSpec({ ...live({ paths: [...IGNORES] }), symlink: { mode: "ignore" } }, linkless)).toBe(true);
    });

    it("rejects a session whose endpoints moved", () => {
        expect(sessionMatchesSpec({ ...live({ paths: [...IGNORES] }), alpha: { path: "/home/u/elsewhere" } }, spec)).toBe(false);
        expect(sessionMatchesSpec({ ...live({ paths: [...IGNORES] }), beta: { host: "intentic-sync-x", path: "/old" } }, spec)).toBe(false);
    });
});

// What every workspace session leaves on its own side, pairing kind aside: what the daemon's own walk leaves out
// (@intentic/workspace-ignore), and the env files that are private by convention.
describe("every pairing's ignores", () => {
    it("leave out Python environments and bytecode, Gradle's caches and scratch space, as the daemon does", () => {
        for (const list of [IGNORES, PROJECT_IGNORES]) {
            expect(list).toEqual(expect.arrayContaining([".venv", "venv", "__pycache__", ".gradle", ".tmp"]));
        }
    });

    // Mutagen's own syntax: a bare name matches at any depth, `*` within one segment. The committed variants
    // (`.env.example`, `.env.production`) are project content and still travel.
    it("leave out the machine-local env files and keep the committed ones", () => {
        expect(IGNORES).toEqual(expect.arrayContaining([".env", ".env.local", ".env.*.local"]));
        expect(IGNORES.filter((pattern) => pattern.startsWith(".env"))).toEqual([".env", ".env.local", ".env.*.local"]);
        expect(PROJECT_IGNORES.filter((pattern) => pattern.startsWith(".env"))).toEqual([".env", ".env.local", ".env.*.local"]);
    });
});

// A PROJECT PAIRING syncs the owner's own folder into its own folder under /work: none of the workspace root's
// shields apply, no state backup rides beside it, and a moved remote folder is a new pair of ends.
describe("a project pairing's sessions", () => {
    const workspace: Pairing & { readonly localDir: string } = {
        sandboxUrl: "https://x.example.dev/",
        sandboxId: "x",
        mode: "sync",
        localDir: "/home/u/proj",
    };
    const project: Pairing & { readonly localDir: string } = {
        ...workspace,
        localDir: "/home/u/code/my-app",
        remoteDir: `${WORKSPACE_ROOT}/my-app`,
        project: true,
    };
    const projectSpec = sessionSpec(project, "portable");

    it("syncs the project folder rather than /work, copy-first, under the pairing's own name", () => {
        expect(projectSpec).toEqual({
            name: "intentic-x",
            localDir: "/home/u/code/my-app",
            remote: { kind: "ssh", alias: "intentic-sync-x" },
            remoteDir: "/work/my-app",
            mode: "one-way-safe",
            ignores: PROJECT_IGNORES,
            from: "local",
            symlinks: "portable",
        });
        expect(mutagenCreateArgs(projectSpec, false).slice(-2)).toEqual(["/home/u/code/my-app", "intentic-sync-x:/work/my-app"]);
    });

    it("leaves a pairing made without a remote dir on /work, with the workspace's ignores", () => {
        expect(sessionSpec(workspace, "portable")).toEqual(spec);
    });

    it("carries no state backup, while a workspace pairing carries one", () => {
        expect(sessionSpecs(project, "portable").map((one) => one.name)).toEqual(["intentic-x"]);
        expect(sessionSpecs(workspace, "portable").map((one) => one.name)).toEqual(["intentic-x", "intentic-x-state"]);
    });

    // A repository's own `.intentic/` and `refs/` are ordinary content of the project: only the workspace root's are the
    // sandbox's, and a project folder is not the workspace root.
    it("drops only the workspace root's own two entries", () => {
        expect(IGNORES.filter((pattern) => !PROJECT_IGNORES.includes(pattern))).toEqual([`/${STATE_DIR}`, `/${REFERENCE_DIR}`]);
        expect(ignoresFor({ project: true })).toBe(PROJECT_IGNORES);
        expect(ignoresFor({})).toBe(IGNORES);
        expect(ignoreMatcher(PROJECT_IGNORES)(STATE_DIR)).toBe(false);
        expect(ignoreMatcher(PROJECT_IGNORES)(REFERENCE_DIR)).toBe(false);
        expect(ignoreMatcher(PROJECT_IGNORES)("node_modules")).toBe(true);
    });

    // Drift is what brings a session to a new remote folder, and it is a new pair of ends: the residue sweep before the
    // replacement reads absence as deletion only against the folder it has been syncing with.
    it("reads a session still syncing /work as drifted, with ends of its own", () => {
        const onWorkspace = {
            alpha: { path: "/home/u/code/my-app" },
            beta: { host: "intentic-sync-x", path: WORKSPACE_ROOT },
            ignore: { paths: [...PROJECT_IGNORES] },
        };
        expect(sessionMatchesSpec(onWorkspace, projectSpec)).toBe(false);
        expect(sameEnds(onWorkspace, projectSpec)).toBe(false);
        expect(convergePlan([onWorkspace], projectSpec)).toBe("replace");
        const moved = { ...onWorkspace, mode: "one-way-safe", beta: { host: "intentic-sync-x", path: "/work/my-app" } };
        expect(sessionMatchesSpec(moved, projectSpec)).toBe(true);
        expect(sameEnds(moved, projectSpec)).toBe(true);
    });

    // A project whose sandbox runs on this machine's own engine is reached through Docker (endpoint.ts): the same session,
    // made with a docker:// URL, and a session made over ssh is a different pair of ends from it.
    const throughDocker = sessionSpec({ ...project, transport: "docker", container: "intentic-sandbox-sandbox-x" }, "portable");

    it("makes a docker pairing's session with a docker:// URL and every other rule of the ssh one", () => {
        expect(throughDocker).toEqual({ ...projectSpec, remote: { kind: "docker", container: "intentic-sandbox-sandbox-x" } });
        expect(mutagenCreateArgs(throughDocker, false).slice(-2)).toEqual(["/home/u/code/my-app", "docker://intentic-sandbox-sandbox-x/work/my-app"]);
        expect(mutagenCreateArgs(throughDocker, false).slice(0, -1)).toEqual(mutagenCreateArgs(projectSpec, false).slice(0, -1));
    });

    it("reads a session made over ssh as drifted once the pairing reaches its sandbox through Docker, and the other way round", () => {
        const overSsh = {
            mode: "one-way-safe",
            alpha: { protocol: "local", path: "/home/u/code/my-app" },
            beta: { protocol: "ssh", host: "intentic-sync-x", path: "/work/my-app" },
            ignore: { paths: [...PROJECT_IGNORES] },
        };
        const overDocker = { ...overSsh, beta: { protocol: "docker", host: "intentic-sandbox-sandbox-x", path: "/work/my-app" } };
        expect(sameEnds(overSsh, throughDocker)).toBe(false);
        expect(convergePlan([overSsh], throughDocker)).toBe("replace");
        expect(sessionMatchesSpec(overDocker, throughDocker)).toBe(true);
        expect(sameEnds(overDocker, projectSpec)).toBe(false);
        // Mutagen prints the protocol; an end read without one is the ssh every earlier session was made over.
        expect(sameEnds({ alpha: { path: "/home/u/code/my-app" }, beta: { host: "intentic-sync-x", path: "/work/my-app" } }, projectSpec)).toBe(true);
    });

    it("is replaced when the pairing changes kind, since the ignore list changes with it", () => {
        const asWorkspace = {
            alpha: { path: "/home/u/code/my-app" },
            beta: { host: "intentic-sync-x", path: "/work/my-app" },
            ignore: { paths: [...IGNORES] },
        };
        expect(sessionMatchesSpec(asWorkspace, projectSpec)).toBe(false);
        expect(sameEnds(asWorkspace, projectSpec)).toBe(true);
    });
});
