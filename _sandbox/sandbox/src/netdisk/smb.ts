import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { NetdiskConfig, SmbNetdiskConfig } from "@intentic/sandbox-contract";
import { toolMissing } from "../tunnel/net-probe.js";
import { isReadOnly, mountAt, readMountinfo } from "./mountinfo.js";
import type { NetdiskDriver, NetdiskProbe } from "./netdisk-driver.js";
import { credentialsPath, mountPoint, netdiskDir } from "./netdisk-paths.js";

// SMB/CIFS through the kernel's cifs client, driven by mount.cifs (cifs-utils). The password reaches it through a 0600
// credentials file, never argv, so it is absent from `ps`. The access switch is the `ro`/`rw` mount flag: the kernel
// refuses writes to a `ro` mount before the server ever sees them.

const exec = promisify(execFile);
const config = (raw: NetdiskConfig): SmbNetdiskConfig => raw as SmbNetdiskConfig;

// A slow or unreachable server must fail the dial, not hang the daemon; mount.cifs has no timeout of its own.
const MOUNT_TIMEOUT_MS = 45_000;

export const smbTarget = (raw: SmbNetdiskConfig): string => `//${raw.server}/${raw.share}${raw.path === undefined || raw.path === "" ? "" : `/${raw.path}`}`;

// `soft`: with the server gone (a VPN dropped), I/O returns EIO instead of hanging every shell that touches the mount
// forever, which is what the default `hard` does to an agent's `ls`.
// `uid=0,gid=0`: every process in the container is root, so ownership maps to the one user there is.
export const smbMountOptions = (raw: SmbNetdiskConfig, credentials: string): string =>
    [
        raw.password === undefined || raw.password === "" ? "guest" : `credentials=${credentials}`,
        ...(raw.password === undefined || raw.password === "" ? [`username=${raw.username}`, ...(raw.domain === undefined || raw.domain === "" ? [] : [`domain=${raw.domain}`])] : []),
        raw.access === "read" ? "ro" : "rw",
        "soft",
        "uid=0",
        "gid=0",
        "file_mode=0644",
        "dir_mode=0755",
        "iocharset=utf8",
        ...(raw.version === "auto" ? [] : [`vers=${raw.version}`]),
    ].join(",");

// The file mount.cifs reads; one key per line, its own format. A password holding a newline cannot be expressed in it.
export const smbCredentialsFile = (raw: SmbNetdiskConfig): string =>
    `${[`username=${raw.username}`, ...(raw.password === undefined ? [] : [`password=${raw.password}`]), ...(raw.domain === undefined || raw.domain === "" ? [] : [`domain=${raw.domain}`])].join("\n")  }\n`;

// mount.cifs reports `mount error(N): <strerror>`; the errno is the one stable thing in it, so the advice keys off that.
const MOUNT_ADVICE: Readonly<Record<number, string>> = {
    1: "the container was not allowed to mount. That is the host's security profile (AppArmor's docker-default denies mount); the sandbox must run unconfined or privileged for a network disk.",
    2: "the share or the folder inside it does not exist on that server. Check the share name and path.",
    13: "the server refused the credentials. Check the username, password and domain; for a guest share, leave the password empty.",
    19: "the host kernel has no cifs support loaded. A network disk needs it on the machine running this sandbox.",
    95: "the server rejected the SMB version. Try a specific version on the card (3.0, 2.1, or 1.0 for old NAS firmware).",
    110: "the server did not answer. Is it behind a VPN that is not connected? `vpn list` shows what is up.",
    111: "the server refused the connection on port 445. Is it a file server, and is that port open?",
    112: "the server is not reachable from this sandbox. Is it behind a VPN that is not connected? `vpn list` shows what is up.",
    113: "there is no route to that server from this sandbox. Is it behind a VPN that is not connected? `vpn list` shows what is up.",
};

export const explainMountFailure = (stderr: string): string => {
    const match = /mount error\((\d+)\)/.exec(stderr);
    const advice = match === null ? undefined : MOUNT_ADVICE[Number(match[1])];
    const raw = stderr.trim() === "" ? "mount.cifs failed without a message" : stderr.trim();
    return advice === undefined ? raw : `${raw}\n${advice}`;
};

const probe = async (id: string): Promise<NetdiskProbe> => {
    const entry = mountAt(await readMountinfo(), mountPoint(id));
    if (entry !== undefined && entry.fsType === "cifs") {
        return { state: "mounted", writable: !isReadOnly(entry) };
    }
    return { state: (await smbMissing()) === undefined ? "unmounted" : "unavailable" };
};

const smbMissing = async (): Promise<string | undefined> => ((await toolMissing("mount.cifs", ["-V"])) ? "mount.cifs" : undefined);

export const smbDriver: NetdiskDriver = {
    target: (raw) => smbTarget(config(raw)),
    write: async (id, raw) => {
        await mkdir(netdiskDir(), { recursive: true, mode: 0o700 });
        await writeFile(credentialsPath(id), smbCredentialsFile(config(raw)), { mode: 0o600 });
    },
    erase: async (id) => {
        await rm(credentialsPath(id), { force: true });
    },
    missingTool: smbMissing,
    async *mount(id, raw) {
        const smb = config(raw);
        const where = mountPoint(id);
        const live = await probe(id);
        if (live.state === "mounted") {
            yield { kind: "log", message: `${id} is already mounted at ${where} (${live.writable === true ? "read-write" : "read-only"}).` };
            return;
        }
        // Re-write before mounting so a password rotated through /secrets takes effect on the next mount.
        await smbDriver.write(id, raw);
        await mkdir(where, { recursive: true });
        yield { kind: "log", message: `Mounting ${smbTarget(smb)} at ${where} ${smb.access === "read" ? "read-only" : "read-write"}…` };
        try {
            await exec("mount", ["-t", "cifs", smbTarget(smb), where, "-o", smbMountOptions(smb, credentialsPath(id))], { timeout: MOUNT_TIMEOUT_MS });
        } catch (error) {
            const failure = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
            throw new Error(failure.killed === true ? `mount.cifs gave up after ${MOUNT_TIMEOUT_MS / 1000}s: ${MOUNT_ADVICE[110]}` : explainMountFailure(failure.stderr ?? failure.message), { cause: error });
        }
        yield { kind: "log", message: `Mounted ${id}. Its files are under ${where}.` };
    },
    unmount: async (id) => {
        const where = mountPoint(id);
        if ((await probe(id)).state !== "mounted") {
            return;
        }
        // Lazy on a busy mount: a shell sitting in the directory must not keep the disk attached to a server the user
        // asked to let go of.
        await exec("umount", [where]).catch(() => exec("umount", ["-l", where]));
        await rm(where, { recursive: false, force: true }).catch(() => undefined);
    },
    probe: (id) => probe(id),
};
