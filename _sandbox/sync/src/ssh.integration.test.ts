import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { describe, expect, it } from "vitest";
import { mutagenCreateArgs, sessionMatchesSpec, sessionName, type SyncSessionSpec } from "./mutagen.js";
import {
    BACKUP_IGNORES,
    IGNORES,
    INCLUDE_MARKER,
    mutagenSshPath,
    pairingSshConfig,
    resolvedEndpoint,
    sanitizeId,
    sshAlias,
    sshConfigBlock,
    stripManagedIncludes,
} from "./ssh.js";
import { syncSshPort } from "./tunnel.js";

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
    // Every sandbox's transport answers on 127.0.0.1, so without an alias the host key of the second sandbox
    // paired reads as the first one's key having changed, which ssh refuses, loudly, in a log nobody reads.
    it("keys known_hosts by the alias, so two sandboxes on one loopback address never collide", () => {
        expect(block).toContain("HostKeyAlias intentic-sync-x");
    });
    /* The alias must be LITERAL. ssh expands no %-tokens in HostKeyAlias, so a `%h` here is the name "%h": one
     * entry shared by every sandbox, which is the collision this option exists to prevent. It shipped that way:
     * with a single pairing nothing looks wrong, and the second sandbox onwards is refused with REMOTE HOST
     * IDENTIFICATION HAS CHANGED for good, since `accept-new` never accepts a CHANGED key. */
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

// The include line is the whole feature on Windows. Mutagen ignores PATH there and takes the first ssh.exe from
// its own hardcoded list: Git for Windows' Cygwin build long before Microsoft's, and a Cygwin ssh does not
// consider "C:/Users/…" absolute: it anchors it under ~/.ssh, matches no file, and (a no-match include being
// silent) reads no config at all. Every Windows setup then died at "unable to receive server magic number: EOF"
// with the alias echoed back as an unresolvable hostname. A relative name is the one spelling every build
// anchors identically.
/* The fragment is regenerated from the pairing LIST. Writing a single block was the first thing that broke a live
 * pairing: pairing a second sandbox overwrote the file, the first sandbox's alias stopped resolving, and Mutagen's
 * ssh then dialled the alias as a literal hostname: surfacing, if at all, as "unable to receive server magic
 * number: EOF" in a log nobody was reading. */
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

    // Two sandboxes sharing one port would give each other's ssh the wrong sandbox: silently, since both ends
    // authenticate fine. The derivation is per-id for exactly this reason.
    it("gives two sandboxes two different ports", () => {
        expect(syncSshPort("sandbox-0738cd6b5027.intentic.dev")).not.toBe(syncSshPort("sandbox-bce57bb9fe3b.intentic.dev"));
    });

    it("is empty when nothing is paired, so unpairing the last sandbox leaves no dangling alias", () => {
        expect(pairingSshConfig([])).toBe("");
    });
});

describe("the managed ssh-config include", () => {
    it("is a bare relative name, never an absolute path", () => {
        expect(INCLUDE_MARKER).toBe("Include intentic-sync.conf");
        expect(INCLUDE_MARKER).not.toMatch(/[/\\]/);
    });

    it("strips every spelling we have ever written, so re-running setup cannot leave two", () => {
        const user = [
            `Include "C:/Users/First Last/.intentic/sync/ssh_config"`,
            "Include /home/u/.intentic/sync/ssh_config",
            "Include intentic-sync.conf",
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

// `ssh -G` prints the fully expanded config, so it is ground truth for whether THAT client read our block:
// one that never saw the include echoes the alias back as the hostname, which is the failure we now catch.
describe("resolvedEndpoint", () => {
    it("reads the resolved HostName and Port out of `ssh -G`", () => {
        expect(resolvedEndpoint("host intentic-sync-x\nuser root\nhostname 127.0.0.1\nport 24567\n")).toEqual({
            hostname: "127.0.0.1",
            port: 24567,
        });
    });

    // The port is what makes the check specific: every pairing's transport is on 127.0.0.1, so a stale block or
    // somebody's `Host *` entry could satisfy the hostname alone while pointing ssh at the wrong sandbox.
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
    alias: "intentic-sync-x",
    remoteDir: WORKSPACE_ROOT,
    mode: "two-way-safe",
    ignores: IGNORES,
    from: "local",
};

/* The state backup, as the same shape with the three fields that differ. Every assertion about it below is really
 * one assertion: this session runs DOWNHILL. Mutagen's one-way modes propagate alpha → beta and nothing warns
 * about the order, so an endpoint pair the wrong way round would not fail: it would replicate the laptop's copy
 * over the sandbox's live state, which is the single worst thing this feature could do. */
const backup: SyncSessionSpec = {
    name: "intentic-x-state",
    localDir: "/home/u/proj/.intentic",
    alias: "intentic-sync-x",
    remoteDir: `${WORKSPACE_ROOT}/.intentic`,
    mode: "one-way-replica",
    ignores: BACKUP_IGNORES,
    from: "sandbox",
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

    // --ignore-vcs covers .git DIRECTORIES only and misses the daemon's pointer FILES; the bare `.git` pattern
    // covers every shape at every level: no git state file-syncs (the bridge carries it by git protocol).
    it("does not pass --ignore-vcs, and ignores .git at every level so no git state ever file-syncs", () => {
        expect(args).not.toContain("--ignore-vcs");
        expect(IGNORES).toContain(".git");
        expect(IGNORES).not.toContain("/.git");
    });

    // A drifted session is recreated, and a recreate must not quietly resume a sync the user paused.
    it("creates pre-paused when asked, with the flag ahead of the endpoint positionals", () => {
        const paused = mutagenCreateArgs(spec, true);
        expect(paused).toContain("--paused");
        expect(paused.indexOf("--paused")).toBeLessThan(paused.indexOf("/home/u/proj"));
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

    it("carries the backup's own ignores, not the workspace session's", () => {
        for (const pattern of BACKUP_IGNORES) {
            expect(args[args.indexOf(pattern) - 1]).toBe("--ignore");
        }
        // The workspace list excludes the state dir wholesale: passing it here would sync nothing at all.
        expect(args).not.toContain(STATE_DIR);
    });

    /* The two halves of the classification, checked as sentences rather than as a list: the rebuildable bulk and
     * every credential stay in the sandbox, and everything a person wrote or that happened here comes down.
     *
     * Whole groups are excluded by FOLDER, which is the readable payoff of the regrouping: three patterns
     * instead of thirteen, and each one a word rather than an inventory. */
    it("leaves credentials and rebuildable bulk behind, a folder at a time", () => {
        expect([...BACKUP_IGNORES].toSorted()).toEqual(["/identity/control-tokens.json", "/local", "/secrets"]);
    });

    /* The partial group is the one worth pinning. `identity` is split: the ownership records come down so the
     * owner keeps a copy of their own access, the control tokens do not, so collapsing it to a folder like the
     * two beside it would silently stop backing up the records. */
    it("excludes the tokens from identity without excluding identity", () => {
        expect(BACKUP_IGNORES).not.toContain("/identity");
        expect(BACKUP_IGNORES).toContain("/identity/control-tokens.json");
    });

    it("copies down what the sandbox going away would otherwise take with it", () => {
        // Nothing under the two authored/record folders may be excluded: those ARE the backup.
        for (const pattern of BACKUP_IGNORES) {
            expect([pattern, pattern.startsWith("/config") || pattern.startsWith("/records")]).toEqual([pattern, false]);
        }
    });
});

// Mutagen freezes a session's configuration at `sync create`: no verb edits a live one, so an agent upgrade
// only reaches an existing pairing if the drift is noticed and the session recreated. This predicate is what
// notices. `--ignore-vcs` (vcs: true) is the exact drift that kept every project's .git out of the sandbox.
describe("sessionMatchesSpec", () => {
    const live = (ignore: { paths?: string[]; vcs?: boolean }) => ({
        alpha: { path: "/home/u/proj" },
        beta: { host: "intentic-sync-x", path: WORKSPACE_ROOT },
        ignore,
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

    it("rejects a session whose endpoints moved", () => {
        expect(sessionMatchesSpec({ ...live({ paths: [...IGNORES] }), alpha: { path: "/home/u/elsewhere" } }, spec)).toBe(false);
        expect(sessionMatchesSpec({ ...live({ paths: [...IGNORES] }), beta: { host: "intentic-sync-x", path: "/old" } }, spec)).toBe(false);
    });
});
