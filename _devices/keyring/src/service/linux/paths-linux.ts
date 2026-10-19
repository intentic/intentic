import { existsSync } from "node:fs";
import { join } from "node:path";

// Where the protected service keeps things on Linux. Every path is fixed and outside the user's home, so a process of
// the user cannot point the service anywhere else:
// - /usr/lib/intentic-keyring/intentic-keyring: the service's own copy of the keyring, owned by root, so a process of
//   the user cannot swap the program that holds the vault;
// - /var/lib/intentic-keyring/<uid>/: the vault, its keys, its audit and the service's own unlock key, owned by the
//   `intentic-keyring` system user, 0700 (systemd's StateDirectory=), read by no process of the user;
// - /run/intentic-keyring/<uid>/: the door, a unix socket and the token beside it, which the service opens to that one
//   uid with an ACL (service-run-linux.ts);
// - /var/lib/intentic-keyring/<uid>.installed: the marker that the service is on for that user, which intentic-machine
//   reads (the directory above it is 0755, the vault folders inside are not);
// - the templated system unit, and the polkit action whose owner annotation lets the service ask polkit about another
//   user's process (unit-linux.ts).

export const UID_RE = /^\d{1,10}$/u;

// The system user the service runs as.
export const SERVICE_USER = "intentic-keyring";
// The polkit action every yes is asked under (polkit-linux.ts).
export const POLKIT_ACTION = "dev.intentic.keyring.consent";

export interface LinuxServicePaths {
    readonly uid: string;
    readonly bin: string;
    readonly exe: string;
    readonly stateRoot: string;
    readonly vaultDir: string;
    // The service's own unlock key and the vault-key wrap made with it (service-key.ts).
    readonly serviceKey: string;
    readonly runDir: string;
    readonly socket: string;
    readonly door: string;
    readonly marker: string;
    readonly unitFile: string;
    readonly unitName: string;
    readonly policyFile: string;
}

export const linuxServicePaths = (uid: string): LinuxServicePaths => {
    if (!UID_RE.test(uid)) {
        throw new Error(`"${uid}" is not a Linux user id`);
    }
    const bin = "/usr/lib/intentic-keyring";
    const stateRoot = "/var/lib/intentic-keyring";
    const vaultDir = join(stateRoot, uid);
    const runDir = join("/run/intentic-keyring", uid);
    return {
        uid,
        bin,
        exe: join(bin, "intentic-keyring"),
        stateRoot,
        vaultDir,
        serviceKey: join(vaultDir, "service-key.json"),
        runDir,
        socket: join(runDir, "door.sock"),
        door: join(runDir, "door.json"),
        marker: join(stateRoot, `${uid}.installed`),
        unitFile: "/etc/systemd/system/intentic-keyring@.service",
        unitName: `intentic-keyring@${uid}.service`,
        policyFile: `/usr/share/polkit-1/actions/${POLKIT_ACTION.replace(/\.consent$/u, "")}.policy`,
    };
};

export const linuxServiceInstalled = (uid: string): boolean => existsSync(linuxServicePaths(uid).marker);
