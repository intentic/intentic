import { chmod, chown, copyFile, mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { writeFileAtomic } from "@intentic/base/fs";
import { agentHomeIn } from "@intentic/local-agent";
import { KEYRING_HOME } from "../../address.js";
import { type Runner, succeeded } from "../../run.js";
import { type LinuxServicePaths, linuxServicePaths, SERVICE_USER, UID_RE } from "./paths-linux.js";
import { addServiceUserArgs, disableArgs, enableArgs, othersInstalledLinux, passwdEntry, policyText, restartArgs, stopArgs, unitText } from "./unit-linux.js";

// `intentic-keyring service install|uninstall` on Linux, run as root through pkexec (intentic-machine's `keyring setup`
// asks for the one administrator's yes). pkexec names the user who asked in PKEXEC_UID, which only pkexec sets for a
// process it started as root. Install makes the `intentic-keyring` system user, puts the service's own copy of the
// program where only root replaces it, writes the unit and the polkit action, moves a per-user vault from before into the
// service's folder, and starts the user's instance; run again, it replaces the program and restarts the instance,
// keeping the vault. Uninstall puts the vault back in the user's folder and takes away what no other user still needs.

const VAULT_FILES = ["vault.json", "keys.json", "audit.jsonl"] as const;

const exists = async (path: string): Promise<boolean> => await stat(path).then(() => true, () => false);

const must = async (runner: Runner, command: string, args: readonly string[]): Promise<void> => {
    const ran = await runner({ command, args, timeoutMs: 60_000 });
    if (!succeeded(ran)) {
        throw new Error(`${command} ${args.join(" ")} failed (${ran.missing ? "not installed" : `exit ${String(ran.exitCode)}`}): ${ran.stderr.trim() || ran.stdout.trim()}`);
    }
};

/** The user pkexec ran this for. */
const invokingUid = (env: NodeJS.ProcessEnv = process.env): string => {
    const uid = env["PKEXEC_UID"] ?? env["SUDO_UID"];
    if (process.getuid?.() !== 0 || uid === undefined || !UID_RE.test(uid) || uid === "0") {
        throw new Error("Passwords' service is installed as root for a user: run this through `intentic-machine keyring setup`, which asks for an administrator's yes.");
    }
    return uid;
};

interface Account {
    readonly uid: number;
    readonly gid: number;
    readonly home: string;
}

const accountOf = async (runner: Runner, name: string): Promise<Account> => {
    const ran = await runner({ command: "getent", args: ["passwd", name], timeoutMs: 10_000 });
    const entry = succeeded(ran) ? passwdEntry(ran.stdout.split("\n")[0] ?? "") : undefined;
    if (entry === undefined) {
        throw new Error(`the system does not know the user ${name}`);
    }
    return entry;
};

const serviceAccount = async (runner: Runner): Promise<Account> => {
    const known = await runner({ command: "getent", args: ["passwd", SERVICE_USER], timeoutMs: 10_000 });
    if (!succeeded(known)) {
        await must(runner, "useradd", addServiceUserArgs());
    }
    return await accountOf(runner, SERVICE_USER);
};

// Copied, not moved, then owned by `to`'s account and made 0600: the vault leaves the user's home for the service's.
const carry = async (from: string, to: string, owner: Account): Promise<boolean> => {
    if (!(await exists(from))) {
        return false;
    }
    await copyFile(from, to);
    await chown(to, owner.uid, owner.gid);
    await chmod(to, 0o600);
    await rm(from, { force: true });
    return true;
};

const userKeyringDir = (user: Account): string => agentHomeIn(user.home, KEYRING_HOME).dir;

export const installLinuxService = async (runner: Runner, program: string = process.execPath, env: NodeJS.ProcessEnv = process.env): Promise<{ readonly uid: string; readonly moved: readonly string[] }> => {
    if (!basename(program).startsWith("intentic-keyring")) {
        throw new Error("The service installs the compiled keyring itself: run it as intentic-keyring.");
    }
    const uid = invokingUid(env);
    const paths = linuxServicePaths(uid);
    const user = await accountOf(runner, uid);
    const service = await serviceAccount(runner);
    // A running instance holds the old program: stopped, then started again with the new one.
    await runner({ command: "systemctl", args: stopArgs(paths), timeoutMs: 60_000 });
    await mkdir(paths.bin, { recursive: true, mode: 0o755 });
    await copyFile(program, paths.exe);
    await chmod(paths.exe, 0o755);
    await writeFileAtomic(paths.unitFile, unitText(paths), 0o644);
    await writeFileAtomic(paths.policyFile, policyText(), 0o644);
    await mkdir(paths.stateRoot, { recursive: true, mode: 0o755 });
    await mkdir(paths.vaultDir, { recursive: true, mode: 0o700 });
    await chown(paths.vaultDir, service.uid, service.gid);
    const moved: string[] = [];
    if (!(await exists(join(paths.vaultDir, "vault.json")))) {
        for (const name of VAULT_FILES) {
            if (await carry(join(userKeyringDir(user), name), join(paths.vaultDir, name), service)) {
                moved.push(name);
            }
        }
    }
    await writeFileAtomic(paths.marker, `${JSON.stringify({ installedAt: new Date().toISOString(), uid })}\n`, 0o644);
    await must(runner, "systemctl", ["daemon-reload"]);
    await must(runner, "systemctl", enableArgs(paths));
    await must(runner, "systemctl", restartArgs(paths));
    return { uid, moved };
};

// What only the last user's uninstall takes: the program, the unit, the polkit action, the system user, the empty root.
const sweepShared = async (runner: Runner, paths: LinuxServicePaths, swept: string[], left: string[]): Promise<void> => {
    for (const path of [paths.unitFile, paths.policyFile]) {
        await rm(path, { force: true });
        swept.push(path);
    }
    try {
        await rm(paths.bin, { recursive: true, force: true });
        swept.push(paths.bin);
    } catch (error) {
        left.push(`${paths.bin} (${errorMessage(error)})`);
    }
    await runner({ command: "systemctl", args: ["daemon-reload"], timeoutMs: 60_000 });
    const removed = await runner({ command: "userdel", args: [SERVICE_USER], timeoutMs: 30_000 });
    if (succeeded(removed)) {
        swept.push(`user ${SERVICE_USER}`);
    } else {
        left.push(`user ${SERVICE_USER} (${removed.stderr.trim() || "userdel failed"})`);
    }
    if (await rmdir(paths.stateRoot).then(() => true, () => false)) {
        swept.push(paths.stateRoot);
    }
};

export const uninstallLinuxService = async (
    runner: Runner,
    env: NodeJS.ProcessEnv = process.env,
): Promise<{ readonly uid: string; readonly restored: readonly string[]; readonly swept: readonly string[]; readonly left: readonly string[] }> => {
    const uid = invokingUid(env);
    const paths = linuxServicePaths(uid);
    const user = await accountOf(runner, uid);
    await runner({ command: "systemctl", args: disableArgs(paths), timeoutMs: 60_000 });
    const own = userKeyringDir(user);
    await mkdir(own, { recursive: true, mode: 0o700 });
    await chown(own, user.uid, user.gid);
    const restored: string[] = [];
    for (const name of VAULT_FILES) {
        if (!(await exists(join(own, name))) && (await carry(join(paths.vaultDir, name), join(own, name), user))) {
            restored.push(name);
        }
    }
    await rm(paths.serviceKey, { force: true });
    await rm(paths.marker, { force: true });
    const swept: string[] = [];
    const left: string[] = [];
    if (await rmdir(paths.vaultDir).then(() => true, () => false)) {
        swept.push(paths.vaultDir);
    }
    // allow(silent-catch): no state root left means no other user's marker either
    const names = await readdir(paths.stateRoot).catch(() => []);
    if (!othersInstalledLinux(names, uid)) {
        await sweepShared(runner, paths, swept, left);
    }
    return { uid, restored, swept, left };
};
