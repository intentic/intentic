import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { readTextIfExistsSync } from "@intentic/base/fs";
import { machineId } from "../machine-id.js";

// Stable environment id (windows, WSL distro, macos, linux) separates SSH key comments, transport port bands and Mutagen owner labels.
// Prefer WSL_DISTRO_NAME; otherwise require both WSL kernel and mounts so Docker Desktop containers are not mistaken for distros.
// Fall back to os-release's stable name when services omit WSL_DISTRO_NAME. Keep detection synchronous and unchanged across reconcile passes.

const WSL_KERNEL = /microsoft/i;



const osReleaseName = (osRelease: string | undefined): string | undefined => {
    const line = (osRelease ?? "").split(/\r?\n/).find((entry) => entry.startsWith("NAME="));
    const name = line?.slice("NAME=".length).trim().replaceAll(/^"|"$/g, "");
    return name === undefined || name === "" ? undefined : name;
};

/** What this agent is, as the pure rule below reads it. */
export interface SyncEnvironment {
    // The word every derived name carries: "windows", "macos", "linux", or the distro's name.
    readonly name: string;
    // Set only inside a WSL distro, where Windows shares the loopback ports this environment binds.
    readonly wsl: boolean;
}

// Pure over what was read, so the rule is checkable from any host.
export const syncEnvironmentFrom = (
    platform: NodeJS.Platform,
    procVersion: string | undefined,
    distroEnv: string | undefined,
    osRelease: string | undefined,
    wslMounts = false,
): SyncEnvironment => {
    if (platform === "win32") {
        return { name: "windows", wsl: false };
    }
    if (platform === "darwin") {
        return { name: "macos", wsl: false };
    }
    const distro = (distroEnv ?? "").trim();
    if (distro !== "" || (WSL_KERNEL.test(procVersion ?? "") && wslMounts)) {
        return { name: distro !== "" ? distro : (osReleaseName(osRelease) ?? "wsl"), wsl: true };
    }
    return { name: "linux", wsl: false };
};

let cached: SyncEnvironment | undefined;

export const syncEnvironment = (): SyncEnvironment =>
    (cached ??= syncEnvironmentFrom(
        process.platform,
        process.platform === "linux" ? readTextIfExistsSync("/proc/version") : undefined,
        process.env["WSL_DISTRO_NAME"],
        process.platform === "linux" ? readTextIfExistsSync("/etc/os-release") : undefined,
        process.platform === "linux" && (existsSync("/run/WSL") || existsSync("/mnt/wsl")),
    ));

// A Mutagen label value, which Mutagen holds to Kubernetes' rule: at most 63 characters of letters, digits, `-`, `_` and
// `.`, beginning and ending with a letter or digit. Anything else in the raw value becomes `-`.
export const labelValue = (raw: string): string => {
    const spelled = raw.replaceAll(/[^A-Za-z0-9._-]+/g, "-");
    const trimmed = (text: string): string => text.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
    const whole = trimmed(spelled);
    if (whole.length <= 63) {
        return whole;
    }
    // Too long to keep whole: the head, then a digest of the whole, so two long values that share a head stay apart.
    const digest = createHash("sha256").update(raw).digest("hex").slice(0, 8);
    return `${trimmed(whole.slice(0, 54))}-${digest}`;
};

// WHO MADE A MUTAGEN SESSION: this computer and this environment of it. One Mutagen daemon may hold sessions an owner's
// own Mutagen made, and nothing but a name prefix said which were this agent's; an unattended sweep that terminates what
// it believes is its own needs to be told, not to guess. `<machineId>-<environment>`.
export const ownerLabel = (machine: string, environment: string): string => labelValue(`${machine}-${environment}`);

let owner: string | undefined;
export const sessionOwner = (): string => (owner ??= ownerLabel(machineId(), syncEnvironment().name));

// THE COMMENT OF A KEY THIS AGENT MAKES, which a sandbox shows and files the enrollment under: `<hostname>-<environment>`,
// so the Windows side of a PC and each of its distros enroll as three names rather than one shared three times. One
// authorized_keys token, so whitespace becomes `-`. Only a key made from now on carries it: a key's comment is part of
// what the sandbox already holds for an existing enrollment, and a sandbox older than this agent reads a changed comment
// on the same key as a second machine holding sync (a 423 on the next setup). The sandbox now tells enrollments apart by
// machine and environment instead (`desktop-sync.ts`), which is what keeps the existing ones apart.
export const keyComment = (host: string = hostname(), environment: string = syncEnvironment().name): string =>
    `${host.replaceAll(/\s+/g, "-") || "intentic-machine"}-${environment.replaceAll(/\s+/g, "-")}`;
