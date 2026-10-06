import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSshKey } from "../credentials/ssh-keys.js";
import { fileSshKeyStore } from "../ssh-key-store.js";
import { adoptLegacySshKeys, hostConfPath, hostKeyFilePath, hostPublicKeyPath, hostsDir, linkSshHosts, writeSshHost } from "../ssh-hosts.js";

// HOME stands in for the container's ephemeral filesystem and `history` for the /history volume: a "recreate"
// is a brand-new HOME pointed at the same history dir.
const tempHome = (): string => {
    const home = mkdtempSync(join(tmpdir(), "ssh-hosts-home-"));
    process.env["HOME"] = home;
    return home;
};

test("the managed dir is a symlink onto the history volume, and its aliases survive a container recreate", async () => {
    const history = mkdtempSync(join(tmpdir(), "ssh-hosts-history-"));
    tempHome();

    await linkSshHosts(history);
    await writeSshHost("box", { host: "1.2.3.4", user: "root", port: 22, identityFile: hostPublicKeyPath("box") });
    writeFileSync(hostPublicKeyPath("box"), "ssh-ed25519 AAAA box\n");

    // The alias landed on the volume, not in HOME.
    expect(lstatSync(hostsDir()).isSymbolicLink()).toBe(true);
    expect(realpathSync(hostsDir())).toBe(realpathSync(join(history, "ssh-hosts")));
    expect(readFileSync(join(history, "ssh-hosts", "box.conf"), "utf8")).toContain("HostName 1.2.3.4");

    // The recreate: everything the container held is gone, the volume is not.
    const recreated = tempHome();
    expect(existsSync(join(recreated, ".ssh", "intentic-hosts"))).toBe(false);

    await linkSshHosts(history);

    expect(readFileSync(hostPublicKeyPath("box"), "utf8")).toBe("ssh-ed25519 AAAA box\n");
    // ~/.ssh/config went with the container, so the Include is re-ensured: without it the alias is inert.
    expect(readFileSync(join(recreated, ".ssh", "config"), "utf8")).toContain("Include intentic-hosts/*.conf");
});

test("linkSshHosts repoints a stale link and refuses to replace a real directory (a dev-host run)", async () => {
    const history = mkdtempSync(join(tmpdir(), "ssh-hosts-history-"));
    const moved = mkdtempSync(join(tmpdir(), "ssh-hosts-history-"));
    tempHome();

    await linkSshHosts(history);
    await linkSshHosts(moved);
    expect(realpathSync(hostsDir())).toBe(realpathSync(join(moved, "ssh-hosts")));

    // A real dir only happens outside the container: the developer's own keys are never clobbered.
    const home = tempHome();
    mkdirSync(join(home, ".ssh", "intentic-hosts"), { recursive: true });
    await expect(linkSshHosts(history)).rejects.toThrow(/not a symlink/);
});

// The Include was once detected with a substring test, so a line the user had commented out read as present and every
// managed alias silently stopped resolving.
test("a commented-out Include is not taken for the live one: the live line is put first and the user's lines kept", async () => {
    const history = mkdtempSync(join(tmpdir(), "ssh-hosts-history-"));
    const home = tempHome();
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "config"), "# Include intentic-hosts/*.conf\nHost box\n    HostName 10.0.0.2\n");

    await linkSshHosts(history);

    expect(readFileSync(join(home, ".ssh", "config"), "utf8")).toBe(
        "Include intentic-hosts/*.conf\n# Include intentic-hosts/*.conf\nHost box\n    HostName 10.0.0.2\n",
    );
});

// An older build wrote each private key beside its alias, where the agent's shell reads it. Boot moves every one it can
// sign with into the key store and repoints the alias at the public half; a crash part-way leaves the key somewhere.
test("adoptLegacySshKeys moves a key file into the store, writes its public half and repoints the alias", async () => {
    const history = mkdtempSync(join(tmpdir(), "ssh-hosts-history-"));
    tempHome();
    await linkSshHosts(history);
    const pair = generateSshKey("intentic-sandbox");
    await writeSshHost("box", { host: "1.2.3.4", user: "root", port: 22, identityFile: hostKeyFilePath("box") });
    writeFileSync(hostKeyFilePath("box"), pair.privateKey, { mode: 0o600 });
    // git access left ssh-keygen's own public file beside its key.
    writeFileSync(`${hostKeyFilePath("box")}.pub`, `${pair.publicKey}\n`);
    const keys = fileSshKeyStore(join(mkdtempSync(join(tmpdir(), "ssh-hosts-auth-")), "ssh-keys"));

    expect(await adoptLegacySshKeys(keys)).toEqual(["box"]);

    expect(await keys.get("box")).toBe(pair.privateKey);
    expect(existsSync(hostKeyFilePath("box"))).toBe(false);
    expect(existsSync(`${hostKeyFilePath("box")}.pub`)).toBe(false);
    expect(readFileSync(hostPublicKeyPath("box"), "utf8")).toBe(`${pair.publicKey}\n`);
    const conf = readFileSync(hostConfPath("box"), "utf8");
    expect(conf).toContain(`IdentityFile "${hostPublicKeyPath("box")}"`);
    expect(conf).toContain("HostName 1.2.3.4");
    // Idempotent: a second boot has nothing left to move.
    expect(await adoptLegacySshKeys(keys)).toEqual([]);
});

test("adoptLegacySshKeys leaves a key it cannot sign with (one with a passphrase) where it is", async () => {
    const history = mkdtempSync(join(tmpdir(), "ssh-hosts-history-"));
    tempHome();
    await linkSshHosts(history);
    const locked = "-----BEGIN OPENSSH PRIVATE KEY-----\nENCRYPTED\n-----END OPENSSH PRIVATE KEY-----\n";
    await writeSshHost("locked", { host: "9.9.9.9", user: "root", port: 22, identityFile: hostKeyFilePath("locked") });
    writeFileSync(hostKeyFilePath("locked"), locked, { mode: 0o600 });
    const keys = fileSshKeyStore(join(mkdtempSync(join(tmpdir(), "ssh-hosts-auth-")), "ssh-keys"));

    expect(await adoptLegacySshKeys(keys)).toEqual([]);

    expect(readFileSync(hostKeyFilePath("locked"), "utf8")).toBe(locked);
    expect(readFileSync(hostConfPath("locked"), "utf8")).toContain(`IdentityFile "${hostKeyFilePath("locked")}"`);
    expect(await keys.aliases()).toEqual([]);
});
