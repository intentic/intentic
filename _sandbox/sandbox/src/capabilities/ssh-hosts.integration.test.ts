import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { hostKeyPath, hostsDir, linkSshHosts, writeSshHost } from "./ssh-hosts.js";

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
    await writeSshHost("box", { host: "1.2.3.4", user: "root", port: 22, identityFile: hostKeyPath("box") });
    writeFileSync(hostKeyPath("box"), "PRIV\n", { mode: 0o600 });

    // The alias landed on the volume, not in HOME.
    expect(lstatSync(hostsDir()).isSymbolicLink()).toBe(true);
    expect(realpathSync(hostsDir())).toBe(realpathSync(join(history, "ssh-hosts")));
    expect(readFileSync(join(history, "ssh-hosts", "box.conf"), "utf8")).toContain("HostName 1.2.3.4");

    // The recreate: everything the container held is gone, the volume is not.
    const recreated = tempHome();
    expect(existsSync(join(recreated, ".ssh", "intentic-hosts"))).toBe(false);

    await linkSshHosts(history);

    expect(readFileSync(hostKeyPath("box"), "utf8")).toBe("PRIV\n");
    // ~/.ssh/config went with the container, so the Include is re-ensured — without it the alias is inert.
    expect(readFileSync(join(recreated, ".ssh", "config"), "utf8")).toContain("Include intentic-hosts/*.conf");
});

test("linkSshHosts repoints a stale link and refuses to replace a real directory (a dev-host run)", async () => {
    const history = mkdtempSync(join(tmpdir(), "ssh-hosts-history-"));
    const moved = mkdtempSync(join(tmpdir(), "ssh-hosts-history-"));
    tempHome();

    await linkSshHosts(history);
    await linkSshHosts(moved);
    expect(realpathSync(hostsDir())).toBe(realpathSync(join(moved, "ssh-hosts")));

    // A real dir only happens outside the container — the developer's own keys are never clobbered.
    const home = tempHome();
    mkdirSync(join(home, ".ssh", "intentic-hosts"), { recursive: true });
    await expect(linkSshHosts(history)).rejects.toThrow(/not a symlink/);
});
