// What the app's processes spent on the CPU while a scenario ran, read from a Perfetto trace of scheduler switches
// with trace_processor. The web arm's renderer runs in the WebView's own sandboxed process, which is counted with it.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const schedConfig = (durationMs: number): string => `
buffers: { size_kb: 65536 fill_policy: RING_BUFFER }
data_sources: {
    config {
        name: "linux.ftrace"
        ftrace_config {
            ftrace_events: "sched/sched_switch"
            ftrace_events: "sched/sched_process_exit"
            ftrace_events: "sched/sched_process_free"
            ftrace_events: "task/task_newtask"
            ftrace_events: "task/task_rename"
        }
    }
}
data_sources: {
    config {
        name: "linux.process_stats"
        process_stats_config { scan_all_processes_on_start: true }
    }
}
duration_ms: ${durationMs}
`;

/** The trace_processor launcher, fetched once; it downloads the matching trace_processor_shell on first use. */
const traceProcessor = (outDir: string): string => {
    const bin = join(outDir, `bin`, `trace_processor`);
    if (!existsSync(bin)) {
        mkdirSync(join(outDir, `bin`), { recursive: true });
        execFileSync(`curl`, [`--fail`, `--location`, `--silent`, `--show-error`, `--output`, bin, `https://get.perfetto.dev/trace_processor`]);
    }
    return bin;
};

const query = (outDir: string, trace: string, sql: string): string[][] => {
    const file = join(outDir, `query.sql`);
    writeFileSync(file, sql);
    const output = execFileSync(`python3`, [traceProcessor(outDir), `-q`, file, trace], { encoding: `utf8`, maxBuffer: 64 * 1024 * 1024, stdio: [`ignore`, `pipe`, `pipe`] });
    return output
        .split(/\r?\n/u)
        .filter((line) => line.startsWith(`"`) || /^\d/u.test(line))
        .map((line) => line.split(`,`).map((cell) => cell.replace(/^"|"$/gu, ``)));
};

export interface CpuUse {
    /** CPU time of every thread of the app's processes over the window, ms. */
    readonly totalMs: number;
    /** That as a share of one core, percent. */
    readonly corePct: number;
    /** The busiest threads, `name: ms`. */
    readonly threads: readonly string[];
}

/** CPU used by `pkg`'s processes (and a WebView renderer's, with `webview`) in the trace's last `windowMs`. */
export const cpuUse = (outDir: string, trace: string, pkg: string, windowMs: number, webview: boolean): CpuUse => {
    const owner = webview ? `(p.name like '${pkg}%' or p.name like '%webview:sandboxed%')` : `p.name like '${pkg}%'`;
    const rows = query(
        outDir,
        trace,
        `with bounds as (select end_ts - ${Math.round(windowMs * 1e6)} as from_ts, end_ts as to_ts from trace_bounds)
select '' || coalesce(t.name, '?') as thread, sum(min(s.ts + s.dur, b.to_ts) - max(s.ts, b.from_ts)) as ns
from sched s join thread t using(utid) join process p using(upid), bounds b
where s.utid != 0 and s.ts + s.dur > b.from_ts and s.ts < b.to_ts and ${owner}
group by thread order by ns desc;`,
    );
    const threads = rows.filter((row) => row.length === 2 && /^\d+$/u.test(row[1] ?? ``)).map(([name, ns]) => ({ name: name ?? `?`, ms: Number(ns) / 1e6 }));
    const totalMs = threads.reduce((sum, thread) => sum + thread.ms, 0);
    return {
        totalMs: Math.round(totalMs),
        corePct: Math.round((totalMs / windowMs) * 100),
        threads: threads.slice(0, 4).map((thread) => `${thread.name}: ${Math.round(thread.ms)}`),
    };
};
