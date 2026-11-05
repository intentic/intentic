import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync, readFileSync, readSync } from "node:fs";
import { errnoCode, errorMessage } from "@intentic/base/errors";
import { opt } from "../../../opt.js";
import { type KernelLine, kernelLinesOf } from "../../resources/kernel-oom-lines.js";

/* WHOSE A KERNEL OOM KILL WAS, AND WHEN (2026-11-05). On the night of the runaway the kernel's global OOM killer ended it
   at 04:21:57 and said so in its ring buffer; nothing in the sandbox read it, so the boot after said only "killed without
   warning". The two lines are parsed in system/resources/kernel-oom-lines.ts, which the daemon's own detector reads them
   with too. This module is what the boot's post-mortem (post-mortem.ts) adds: the whole ring read back, each stamp dated,
   and whether a kill was in THIS sandbox, since the ring buffer is the machine's (a WSL VM or a host shared by many
   containers) and a kill in another container is somebody else's news.

   - The time is microseconds since the kernel started, stamped by its local clock, which stops while the machine is
     suspended, as CLOCK_MONOTONIC does and /proc/uptime (CLOCK_BOOTTIME) does not; so a stamp is dated by today's wall
     clock less Node's monotonic clock (libuv's hrtime is CLOCK_MONOTONIC), which stays right across a laptop's sleep
     where /proc/uptime or btime would put every line hours early.
   - Which sandbox it hit is the `task_memcg` path, the cgroup the victim was in as the kernel names it from the
     machine's root: under docker it holds the container's 64-hex id (`/docker/<id>/workload`,
     `/system.slice/docker-<id>.scope`), which the container finds in its own /proc/self/mountinfo, where /etc/hostname,
     /etc/hosts and /etc/resolv.conf are bind-mounted from the engine's per-container directory. Inside a cgroup
     namespace /proc/self/cgroup only says `0::/workload`, so it cannot answer that. */

/* WHICH SANDBOX A KILL HIT. */

// The engines' per-container directories, where the /etc/hostname, /etc/hosts and /etc/resolv.conf bind mounts come
// from: docker's /var/lib/docker/containers/<id>/, podman's …/overlay-containers/<id>/userdata/.
const ENGINE_DIR = /\/(?:containers|overlay-containers)\/([0-9a-f]{64})\//u;
const FULL_ID = /^[0-9a-f]{64}$/u;
const SHORT_ID = /^[0-9a-f]{12}$/u;
const ENGINE_MOUNTS = new Set(["/etc/hostname", "/etc/hosts", "/etc/resolv.conf"]);

// A cgroup path segment as the engines name a container's: bare (`/docker/<id>`, cgroupfs) or wrapped in a systemd
// scope (`docker-<id>.scope`, `libpod-<id>.scope`, `crio-<id>.scope`, `cri-containerd-<id>.scope`).
const idOfSegment = (segment: string): string => segment.replace(/^(?:docker|libpod|crio|cri-containerd)-/u, "").replace(/\.scope$/u, "");

/** What the files a container sees of itself say about which container it is. */
export interface IdentitySources {
    readonly mountinfo?: string;
    readonly procSelfCgroup?: string;
    readonly hostname?: string;
}

/**
 * This container's id as its engine names it in the machine's cgroup tree: the 64-hex id from the source of the
 * /etc/hostname (or hosts, resolv.conf) bind mount; else one in /proc/self/cgroup, which shows the machine's path when
 * there is no cgroup namespace; else the 12-hex short id docker gives a container as its hostname by default.
 * Undefined outside a container, or in one that hides all three.
 */
export const containerIdOf = (sources: IdentitySources): string | undefined => {
    for (const line of (sources.mountinfo ?? "").split("\n")) {
        // mountinfo: id parent major:minor root mount-point options … — the root is the source path within its filesystem.
        const fields = line.split(" ");
        if (ENGINE_MOUNTS.has(fields[4] ?? "")) {
            const id = ENGINE_DIR.exec(fields[3] ?? "")?.[1];
            if (id !== undefined) {
                return id;
            }
        }
    }
    const path = (sources.procSelfCgroup ?? "").split("\n").find((line) => line.startsWith("0::"))?.slice(3) ?? "";
    const fromCgroup = path.split("/").map(idOfSegment).find((segment) => FULL_ID.test(segment));
    if (fromCgroup !== undefined) {
        return fromCgroup;
    }
    const hostname = (sources.hostname ?? "").trim();
    return SHORT_ID.test(hostname) ? hostname : undefined;
};

// This sandbox's own leaves, as the kernel names them on a machine that is the sandbox (a VM with no container around
// it, where nothing namespaces the cgroup tree): the entrypoint's `workload` and `daemon`.
const VM_LEAVES = ["/workload", "/daemon"];

/**
 * Whether a kill's `task_memcg` is this sandbox's: a segment of it is this container's id (a short id matches the full
 * id it begins); with no container id at all, it is one of the sandbox's own leaves at the machine's root.
 */
export const memcgIsOurs = (memcg: string | undefined, containerId: string | undefined): boolean => {
    if (memcg === undefined) {
        return false;
    }
    if (containerId === undefined) {
        return VM_LEAVES.some((leaf) => memcg === leaf || memcg.startsWith(`${leaf}/`));
    }
    return memcg.split("/").some((segment) => {
        const id = idOfSegment(segment);
        return FULL_ID.test(id) && id.startsWith(containerId);
    });
};

/** Whether the cgroup is the daemon's own leaf (docker-entrypoint.sh's `daemon`, where netd and the daemon run). */
export const memcgIsDaemonLeaf = (memcg: string | undefined): boolean => memcg !== undefined && memcg.split("/").at(-1) === "daemon";

/* READING THE RING. */

/** What reading the kernel's log found: its lines, where they came from, and why there are none when there are none. */
export interface KernelLog {
    readonly lines: readonly KernelLine[];
    readonly source: "kmsg" | "dmesg" | "none";
    // Why the log could not be read (EPERM under kernel.dmesg_restrict without CAP_SYSLOG, no /dev/kmsg and no dmesg).
    readonly problem?: string;
}

// The ring is a few hundred KiB to a few MiB; a reader that keeps finding records (a kernel logging as fast as it is
// read) stops here rather than never.
const MAX_RECORDS = 100_000;
// One /dev/kmsg record is at most about 1 KiB of text and its dictionary; a read into a smaller buffer is refused.
const RECORD_BYTES = 16 * 1024;

const readKmsg = (path: string): KernelLog => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
        const buffer = Buffer.alloc(RECORD_BYTES);
        const records: string[] = [];
        while (records.length < MAX_RECORDS) {
            let got: number;
            try {
                got = readSync(fd, buffer, 0, buffer.length, null);
            } catch (error) {
                const code = errnoCode(error);
                // EAGAIN: read to the newest record. EPIPE: the record about to be read was overwritten while reading,
                // and the next read goes on from the oldest one left.
                if (code === "EAGAIN") {
                    break;
                }
                if (code === "EPIPE") {
                    continue;
                }
                throw error;
            }
            if (got === 0) {
                break;
            }
            // One record per read: its header line, then its dictionary lines, which kernelLinesOf leaves out.
            records.push(buffer.toString("utf8", 0, got));
        }
        return { lines: kernelLinesOf(records.join("")), source: "kmsg" };
    } finally {
        closeSync(fd);
    }
};

const DENIED = new Set(["EPERM", "EACCES"]);

/**
 * The kernel's log as far back as its ring still reaches, read without blocking: /dev/kmsg from its oldest record to its
 * newest, else `dmesg` where there is no /dev/kmsg. A log the sandbox may not read (EPERM) or that is not there reads
 * as no lines with the reason, never a throw: a post-mortem without the kernel's word is still one.
 */
export const readKernelLog = (options: { readonly kmsgPath?: string; readonly dmesg?: () => string } = {}): KernelLog => {
    let kmsgProblem: string;
    try {
        return readKmsg(options.kmsgPath ?? "/dev/kmsg");
    } catch (error) {
        const code = errnoCode(error);
        kmsgProblem = `/dev/kmsg: ${code ?? errorMessage(error)}`;
        // dmesg reads the same ring under the same rule, so a refusal here is a refusal there.
        if (code !== undefined && DENIED.has(code)) {
            return { lines: [], source: "none", problem: kmsgProblem };
        }
    }
    try {
        // allow(process-tiers): one dmesg per boot, only where there is no /dev/kmsg, bounded by its 3 s timeout and 16 MiB of output; the post-mortem reads the log synchronously and runCheck cannot.
        const text = options.dmesg?.() ?? execFileSync("dmesg", [], { encoding: "utf8", timeout: 3000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
        return { lines: kernelLinesOf(text), source: "dmesg" };
    } catch (error) {
        return { lines: [], source: "none", problem: `${kmsgProblem}; dmesg: ${errnoCode(error) ?? errorMessage(error)}` };
    }
};

/** When the kernel's clock read zero, as epoch ms: the wall clock less the monotonic clock the kernel stamps by. */
export const kernelZeroEpochMs = (nowMs: number = Date.now(), monotonicMs: number = Number(process.hrtime.bigint() / 1_000_000n)): number => nowMs - monotonicMs;

/** A kernel stamp as epoch ms. */
export const epochOfKernel = (bootUs: number, zeroEpochMs: number): number => Math.round(zeroEpochMs + bootUs / 1000);

const readOptional = (path: string): string | undefined => {
    try {
        return readFileSync(path, "utf8");
    } catch {
        // allow(silent-catch): a file this container does not have (no bind-mounted hostname, no procfs) is one source fewer, which containerIdOf weighs
        return undefined;
    }
};

/** This container's id, read from what it sees of itself (containerIdOf). */
export const readContainerId = (): string | undefined =>
    containerIdOf({
        ...opt("mountinfo", readOptional("/proc/self/mountinfo")),
        ...opt("procSelfCgroup", readOptional("/proc/self/cgroup")),
        ...opt("hostname", readOptional("/etc/hostname")),
    });
