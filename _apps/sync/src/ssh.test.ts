import { describe, expect, it } from "vitest";
import { mutagenCreateArgs, sessionMatchesSpec, sessionName, type SyncSessionSpec } from "./mutagen.js";
import { IGNORES, sanitizeId, sshAlias, sshConfigBlock } from "./ssh.js";

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

    // --ignore-vcs would re-block a nested repo's .git — the thing that makes a synced project a REPO in the
    // sandbox — while still missing the root pointer FILE its directory-only patterns can't match.
    it("does not pass --ignore-vcs, and anchors the root .git ignore so only /work's own pointer file is excluded", () => {
        expect(args).not.toContain("--ignore-vcs");
        expect(IGNORES).toContain("/.git");
        expect(IGNORES).not.toContain(".git");
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
        expect(sessionMatchesSpec(live({ paths: IGNORES.filter((pattern) => pattern !== "/.git") }), spec)).toBe(false);
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
