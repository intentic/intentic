import { readFileSync } from "node:fs";

/* Linux procfs's process identity and the fields this daemon reads from it, parsed once. */

export interface ParsedProcStat {
    // The kernel's comm: the executable's basename, at most 15 characters, and free to contain spaces and parentheses.
    readonly comm: string;
    readonly ppid: number;
    readonly pgrp: number;
    // The session it belongs to: a tmux pane's root process leads one, and whatever it starts keeps it, reparented or not.
    readonly session?: number;
    // User plus system time, in clock ticks.
    readonly cpuTicks?: number;
    // The same for children already waited for: what a reaped command leaves in the parent that collected it.
    readonly childCpuTicks?: number;
    readonly startTimeTicks?: number;
    // Resident set, in pages.
    readonly rssPages?: number;
}

const nonnegativeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const sumOf = (left: number, right: number): number | undefined => ([left, right].every(nonnegativeInteger) ? left + right : undefined);

export const parseProcStat = (stat: string): ParsedProcStat | undefined => {
    // comm is bracketed by the FIRST "(" and the LAST ")", since a comm may itself hold either.
    const close = stat.lastIndexOf(")");
    const fields = stat
        .slice(close + 1)
        .trim()
        .split(/\s+/u);
    const ppid = Number(fields[1]);
    const pgrp = Number(fields[2]);
    const session = Number(fields[3]);
    const cpuTicks = sumOf(Number(fields[11]), Number(fields[12]));
    const childCpuTicks = sumOf(Number(fields[13]), Number(fields[14]));
    const startTimeTicks = Number(fields[19]);
    const rssPages = Number(fields[21]);
    if (![ppid, pgrp].every(nonnegativeInteger)) {
        return undefined;
    }
    return {
        comm: stat.slice(stat.indexOf("(") + 1, close),
        ppid,
        pgrp,
        ...(nonnegativeInteger(session) ? { session } : {}),
        ...(cpuTicks === undefined ? {} : { cpuTicks }),
        ...(childCpuTicks === undefined ? {} : { childCpuTicks }),
        ...(nonnegativeInteger(startTimeTicks) ? { startTimeTicks } : {}),
        ...(nonnegativeInteger(rssPages) ? { rssPages } : {}),
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
