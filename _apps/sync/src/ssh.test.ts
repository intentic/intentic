import { describe, expect, it } from "vitest";
import { mutagenCreateArgs, sessionName } from "./mutagen.js";
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

describe("mutagenCreateArgs", () => {
    const args = mutagenCreateArgs({ name: "intentic-x", localDir: "/home/u/proj", alias: "intentic-sync-x", remoteDir: "/work" });
    it("names the session, pins the safe conflict mode, ignores VCS + our set, stages neighboring, and orders local→remote", () => {
        expect(args.slice(0, 4)).toEqual(["sync", "create", "--name", "intentic-x"]);
        // Pinned explicitly so a Mutagen default change or a user's global config can't flip it to a clobbering mode.
        expect(args[args.indexOf("--sync-mode") + 1]).toBe("two-way-safe");
        expect(args).toContain("--ignore-vcs");
        for (const pattern of IGNORES) {
            const at = args.indexOf(pattern);
            expect(args[at - 1]).toBe("--ignore");
        }
        expect(args).toContain("--stage-mode-beta");
        // local dir precedes the remote alias:path
        expect(args.indexOf("/home/u/proj")).toBeLessThan(args.indexOf("intentic-sync-x:/work"));
    });
});
