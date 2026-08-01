import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mutagenCreateArgs, sessionMatchesSpec, sessionName, type SyncSessionSpec } from "./mutagen.js";
import { IGNORES, INCLUDE_MARKER, mutagenSshPath, resolvedHostname, sanitizeId, sshAlias, sshConfigBlock, stripManagedIncludes } from "./ssh.js";

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
        hostname: "ssh-abc123.example.dev",
        identityFile: "/home/u/.intentic/sync/id_ed25519",
        knownHostsFile: "/home/u/.intentic/sync/known_hosts",
        cloudflaredPath: "/home/u/.intentic/sync/bin/cloudflared",
    });
    it("routes through cloudflared and pins our key + known_hosts", () => {
        expect(block).toContain("Host intentic-sync-x");
        expect(block).toContain("HostName ssh-abc123.example.dev");
        expect(block).toContain('ProxyCommand "/home/u/.intentic/sync/bin/cloudflared" access ssh --hostname %h');
        expect(block).toContain('IdentityFile "/home/u/.intentic/sync/id_ed25519"');
        expect(block).toContain("IdentitiesOnly yes");
        expect(block).toContain('UserKnownHostsFile "/home/u/.intentic/sync/known_hosts"');
    });
    it("quotes Windows paths with spaces and converts backslashes (OpenSSH globs paths POSIX-style)", () => {
        const win = sshConfigBlock({
            alias: "intentic-sync-x",
            hostname: "ssh-abc123.example.dev",
            identityFile: "C:\\Users\\First Last\\.intentic\\sync\\id_ed25519",
            knownHostsFile: "C:\\Users\\First Last\\.intentic\\sync\\known_hosts",
            cloudflaredPath: "C:\\Users\\First Last\\.intentic\\sync\\bin\\cloudflared.exe",
        });
        expect(win).toContain('IdentityFile "C:/Users/First Last/.intentic/sync/id_ed25519"');
        expect(win).toContain('UserKnownHostsFile "C:/Users/First Last/.intentic/sync/known_hosts"');
        expect(win).toContain('ProxyCommand "C:/Users/First Last/.intentic/sync/bin/cloudflared.exe" access ssh --hostname %h');
    });
});

// The include line is the whole feature on Windows. Mutagen ignores PATH there and takes the first ssh.exe from
// its own hardcoded list — Git for Windows' Cygwin build long before Microsoft's — and a Cygwin ssh does not
// consider "C:/Users/…" absolute: it anchors it under ~/.ssh, matches no file, and (a no-match include being
// silent) reads no config at all. Every Windows setup then died at "unable to receive server magic number: EOF"
// with the alias echoed back as an unresolvable hostname. A relative name is the one spelling every build
// anchors identically.
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

// `ssh -G` prints the fully expanded config, so it is ground truth for whether THAT client read our block —
// one that never saw the include echoes the alias back as the hostname, which is the failure we now catch.
describe("resolvedHostname", () => {
    it("reads the resolved HostName out of `ssh -G`", () => {
        expect(resolvedHostname("host intentic-sync-x\nuser root\nhostname ssh-abc123.example.dev\nport 22\n")).toBe("ssh-abc123.example.dev");
    });

    it("reads back the alias itself when the config was invisible", () => {
        expect(resolvedHostname("host intentic-sync-x\nhostname intentic-sync-x\nport 22\n")).toBe("intentic-sync-x");
    });

    it("is undefined when ssh printed no hostname at all", () => {
        expect(resolvedHostname("")).toBeUndefined();
    });
});

const spec: SyncSessionSpec = { name: "intentic-x", localDir: "/home/u/proj", alias: "intentic-sync-x", remoteDir: "/work" };

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
    // covers every shape at every level — no git state file-syncs (the bridge carries it by git protocol).
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

// Mutagen freezes a session's configuration at `sync create` — no verb edits a live one — so an agent upgrade
// only reaches an existing pairing if the drift is noticed and the session recreated. This predicate is what
// notices. `--ignore-vcs` (vcs: true) is the exact drift that kept every project's .git out of the sandbox.
describe("sessionMatchesSpec", () => {
    const live = (ignore: { paths?: string[]; vcs?: boolean }) => ({
        alpha: { path: "/home/u/proj" },
        beta: { host: "intentic-sync-x", path: "/work" },
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
