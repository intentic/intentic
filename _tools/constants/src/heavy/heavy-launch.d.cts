// Types for heavy-launch.cjs: what a heavy program is started through once queue-run has let it in.

// One look at the CPUs: how many cores were busy over it, in all and each.
export interface CpuLook {
    readonly busy: number;
    readonly count: number;
    readonly perCpu: readonly { readonly cpu: number; readonly busy: number }[];
}

export interface CpuTicks {
    readonly cpu: number;
    readonly busy: number;
    readonly total: number;
}

export const CARGO_JOB_BYTES: number;

export function parseProcStat(text: string | undefined): CpuTicks[];
export function busyBetween(before: readonly CpuTicks[], after: readonly CpuTicks[]): CpuLook;
export function waitForIdle(options: {
    readonly need: number;
    readonly ceilingSeconds: number;
    readonly prefix: string;
    readonly why: string;
    readonly look?: () => Promise<CpuLook>;
    readonly now?: () => number;
    readonly pause?: (ms: number) => Promise<void>;
}): Promise<{ readonly calm: boolean; readonly look: CpuLook; readonly waitedMs: number }>;
// The `count` idlest CPUs, among those this process may run on, in order.
export function idlestCpus(look: CpuLook, count: number, allowed?: ReadonlySet<number>): number[];
// Whether the command, its environment or the project's cargo config already chose cargo's jobs, and libtest's threads.
export function cargoChosen(options: { readonly args: readonly string[]; readonly env: Readonly<Record<string, string | undefined>>; readonly cwd: string }): {
    readonly jobs: boolean;
    readonly threads: boolean;
};
export function cargoJobs(options: { readonly cores: number; readonly slots: number; readonly idle: number; readonly roomBytes: number | undefined }): number;
export function cargoParallelism(options: {
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly cwd: string;
    readonly cores: number;
    readonly slots: number;
    readonly look: CpuLook;
    readonly roomBytes: number | undefined;
}): { readonly set: Readonly<Record<string, string>>; readonly line: string } | undefined;
export function parseArgs(argv: readonly string[]): {
    readonly command: string[];
    readonly parallel: string | undefined;
    readonly slots: number;
    readonly cpus: number | undefined;
    readonly idle: number | undefined;
    readonly calmWait: number;
    readonly pin: boolean;
    readonly quiet: boolean;
    readonly label: string;
};
