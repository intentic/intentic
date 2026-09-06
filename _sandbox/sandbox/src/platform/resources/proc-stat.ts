import { readFileSync } from "node:fs";

/* Linux procfs's process identity and the fields this daemon reads from it, parsed once.
 *
 * A pid is only an address into the process table: after a container restart the sandbox daemon commonly gets
 * pid 7 again. The start-time tick is the kernel's identity for that occupant of the address, and is what makes
 * a persisted claim belong to one process rather than to every future process that reuses its pid.
 *
 * `comm` is parenthesized and may itself contain spaces or `)`, so fields are split only after its LAST closing
 * parenthesis. The returned indexes are Linux proc_pid_stat(5)'s fields 4, 5, 14+15 and 22. */

export interface ParsedProcStat {
    readonly ppid: number;
    readonly pgrp: number;
    readonly cpuTicks?: number;
    readonly startTimeTicks?: number;
}

const nonnegativeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

export const parseProcStat = (stat: string): ParsedProcStat | undefined => {
    const fields = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/u);
    const ppid = Number(fields[1]);
    const pgrp = Number(fields[2]);
    const userTicks = Number(fields[11]);
    const systemTicks = Number(fields[12]);
    const startTimeTicks = Number(fields[19]);
    if (![ppid, pgrp].every(nonnegativeInteger)) {
        return undefined;
    }
    return {
        ppid,
        pgrp,
        ...([userTicks, systemTicks].every(nonnegativeInteger) ? { cpuTicks: userTicks + systemTicks } : {}),
        ...(nonnegativeInteger(startTimeTicks) ? { startTimeTicks } : {}),
    };
};

export const parentPid = (stat: string): number | undefined => {
    const ppid = parseProcStat(stat)?.ppid;
    return ppid !== undefined && ppid > 0 ? ppid : undefined;
};

export interface ProcessIdentity {
    readonly pid: number;
    readonly startTimeTicks: number;
}

export const processIdentity = (pid: number = process.pid): ProcessIdentity | undefined => {
    try {
        const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
        return stat?.startTimeTicks === undefined ? undefined : { pid, startTimeTicks: stat.startTimeTicks };
    } catch {
        return undefined;
    }
};

export const sameProcess = (identity: ProcessIdentity): boolean => {
    const current = processIdentity(identity.pid);
    return current !== undefined && current.startTimeTicks === identity.startTimeTicks;
};
