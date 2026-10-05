import { readdir, readFile } from "node:fs/promises";
import { endianness } from "node:os";
import { mapPool } from "@intentic/base/async";
import type { ProcessRole } from "@intentic/sandbox-contract";
import { DAEMON_GEN_ENV, DEADLINE_ENV, DETACHED_ENV, DETACHED_KINDS, type DetachedKind, WORKLOAD_ENV } from "../../seams/workload-stamp.js";
import { opt } from "../../opt.js";
import { type ReadText, readText } from "./cgroup.js";
import { type ParsedProcStat, parseProcStat } from "./proc-stat.js";

// Every process and what it is: stamp, argv and cgroup are fixed at exec, so each is read once in a process's life.

const NUMERIC = /^\d+$/u;
// procfs reads in flight at once, so the daemon's other file work never queues behind hundreds of them.
const READ_CONCURRENCY = 8;

export const listPids = async (): Promise<number[]> =>
    (await readdir("/proc").catch(() => [] as string[])).filter((entry) => NUMERIC.test(entry)).map(Number);

// What /proc/<pid>/stat counts in: bytes per page for `rss`, clock ticks per second for CPU and start times.
export interface ProcUnits {
    readonly pageBytes: number;
    readonly ticksPerSecond: number;
}

// USER_HZ and the page size on every platform this daemon ships for; used only when auxv cannot be read.
const DEFAULT_UNITS: ProcUnits = { pageBytes: 4096, ticksPerSecond: 100 };
const AT_PAGESZ = 6n;
const AT_CLKTCK = 17n;

// The auxiliary vector the kernel handed this process: pairs of 64-bit words, type then value, in native byte order.
export const parseAuxv = (auxv: Buffer, littleEndian: boolean): ProcUnits => {
    const entries = new Map<bigint, bigint>();
    for (let at = 0; at + 16 <= auxv.length; at += 16) {
        entries.set(
            littleEndian ? auxv.readBigUInt64LE(at) : auxv.readBigUInt64BE(at),
            littleEndian ? auxv.readBigUInt64LE(at + 8) : auxv.readBigUInt64BE(at + 8),
        );
    }
    const pageBytes = Number(entries.get(AT_PAGESZ) ?? 0n);
    const ticksPerSecond = Number(entries.get(AT_CLKTCK) ?? 0n);
    return {
        pageBytes: pageBytes > 0 ? pageBytes : DEFAULT_UNITS.pageBytes,
        ticksPerSecond: ticksPerSecond > 0 ? ticksPerSecond : DEFAULT_UNITS.ticksPerSecond,
    };
};

let units: Promise<ProcUnits> | undefined;
export const procUnits = (): Promise<ProcUnits> =>
    (units ??= readFile("/proc/self/auxv")
        .then((auxv) => parseAuxv(auxv, endianness() === "LE"))
        .catch(() => DEFAULT_UNITS));

// Reads procfs's NUL-separated environ, fixed at exec, so a process cannot rewrite the stamp it was born with.
export const ownerOf = (environ: string): string | undefined => envValue(environ, WORKLOAD_ENV);

const envValue = (environ: string, name: string): string | undefined => {
    for (const entry of environ.split("\0")) {
        if (entry.startsWith(`${name}=`)) {
            return entry.slice(name.length + 1);
        }
    }
    return undefined;
};

// The stamps besides the owner (seams/workload-stamp.ts): which daemon run started it, and for a detached child of the
// daemon's own, what it is and when it is overdue. Absent fields were not stamped.
export interface ProcessStamps {
    readonly generation?: string;
    readonly detached?: DetachedKind;
    readonly deadlineAt?: number;
}

const DETACHED: ReadonlySet<string> = new Set(DETACHED_KINDS);

export const stampsOf = (environ: string): ProcessStamps => {
    const generation = envValue(environ, DAEMON_GEN_ENV);
    const detached = envValue(environ, DETACHED_ENV);
    const deadlineAt = Number(envValue(environ, DEADLINE_ENV) ?? Number.NaN);
    return {
        ...opt("generation", generation === "" ? undefined : generation),
        // SAFETY: membership in DETACHED_KINDS is checked in the same expression.
        ...opt("detached", detached !== undefined && DETACHED.has(detached) ? (detached as DetachedKind) : undefined),
        ...opt("deadlineAt", Number.isFinite(deadlineAt) && deadlineAt > 0 ? deadlineAt : undefined),
    };
};

// A label is one of these words or nothing, never argv (a prompt, a path); longer first so `vue-tsc` is not read as `tsc`.
const PROGRAMS = [
    "vue-tsc",
    "vitest",
    "tsc",
    "tsgo",
    "turbo",
    "vite",
    "esbuild",
    "tsdown",
    "oxlint",
    "prettier",
    "knip",
    "pnpm",
    "npm",
    "npx",
    "yarn",
    "bun",
    "claude",
    "codex",
    "opencode",
    "gemini",
    "kimi",
    "chrome",
    "chromium",
    "firefox",
    "webkit",
    "playwright",
    "llama-server",
    "ollama",
    "tsserver",
    "iq-engine",
    "iq",
    "git",
    "tmux",
    "postgres",
    "nginx",
    "dockerd",
    "containerd",
    "node",
] as const;

// A whole word or path component; `-` opens one (`google-chrome`), `.` and `@` close one (`vite.js`, `vitest@4.0.0`).
const programPattern = (name: string): RegExp => new RegExp(`(^|[ /-])${name}([ /.@-]|$)`, "u");

const PROGRAM_PATTERNS = PROGRAMS.map((name) => [name, programPattern(name)] as const);

export const programOf = (command: string): string | undefined => {
    const value = command.toLowerCase();
    return PROGRAM_PATTERNS.find(([, pattern]) => pattern.test(value))?.[0];
};

// A turn's build, test or typecheck and the package manager driving it; `tsgo --lsp` is a language server instead.
const TOOLCHAIN = [
    "vue-tsc",
    "vitest",
    "tsc",
    "turbo",
    "vite",
    "esbuild",
    "tsdown",
    "oxlint",
    "prettier",
    "knip",
    "pnpm",
    "npm",
    "npx",
    "yarn",
    "bun",
].map(programPattern);
const TSGO = /(^|[ /])tsgo([ .]|$)/u;
const isToolchain = (value: string): boolean => TOOLCHAIN.some((pattern) => pattern.test(value)) || (TSGO.test(value) && !/--lsp\b/u.test(value));

// A nested container's process, by the cgroup it sits in, or the engine that runs it, by name.
const CONTAINER_CGROUP = /[/]docker[/]/u;
const CONTAINER = /(^|[ /])(dockerd|containerd|docker-proxy|docker-init|runc)([ /-]|$)/u;

const LOCAL_MODEL = /(^|[ /-])(llama-server|llama-cli|llamafile|ollama)([ /.-]|$)/u;

const BROWSER = /chrom(e|ium)|firefox|webkit|playwright|browser-mcp|browser_server/u;
const LANGUAGE_SERVER =
    /typescript-language-server|tsserver|rust-analyzer|pyright|pylsp|gopls|clangd|jdtls|solargraph|intelephense|language-server|lsp-daemon/u;
const OWN_LANGUAGE_SERVER = /@intentic[/]lsp|_search[/]lsp|[/]lsp[/]dist[/]cli|(^|[ /])lsp([ /]|$)|(^|[ /])tsgo([ .]|$)/u;
// Its own role, not `other`: a long-lived index host with a heap cap of its own, whose growth `other` would hide.
const SEARCH_ENGINE = /iq-engine|(^|[ /])iq([ /]|$)/u;
const TRANSLATOR = /cli-proxy-api|endpoint-translator|translator-proxy/u;
const EXTENSION = /extension-backend|extension-host|backend-host-main|backend-supervisor/u;
const GIT = /git.*fork.*broker|(^|[ /])git([ /]|$)/u;
const AGENT_RUNTIME = /(^|[ /])(claude|codex|opencode|gemini|kimi)([ /]|$)|agent-runtime/u;
const TERMINAL = /(^|[ /])(tmux|bash|zsh|fish|sshd)([ :/]|$)/u;

// Order matters: an engine before what it runs, a one-shot tsgo before the language server it can also be.
const ROLE_RULES: readonly (readonly [ProcessRole, (value: string) => boolean])[] = [
    ["container", (value) => CONTAINER.test(value)],
    ["browser", (value) => BROWSER.test(value)],
    ["localModel", (value) => LOCAL_MODEL.test(value)],
    ["toolchain", isToolchain],
    ["languageServer", (value) => LANGUAGE_SERVER.test(value) || OWN_LANGUAGE_SERVER.test(value)],
    ["searchEngine", (value) => SEARCH_ENGINE.test(value)],
    ["translator", (value) => TRANSLATOR.test(value)],
    ["extension", (value) => EXTENSION.test(value)],
    ["git", (value) => GIT.test(value)],
    ["agentRuntime", (value) => AGENT_RUNTIME.test(value)],
    ["terminal", (value) => TERMINAL.test(value)],
];

// What classifyProcess reads: the kernel's name for the process, then its NUL-separated argv.
export const commandOf = (comm: string, cmdline: string): string => `${comm} ${cmdline.replaceAll("\0", " ")}`;

// A nested container's process is the container's whatever it runs, by the cgroup it sits in.
export const classifyProcess = (command: string, cgroup = ""): ProcessRole => {
    if (CONTAINER_CGROUP.test(cgroup)) {
        return "container";
    }
    const value = command.toLowerCase();
    return ROLE_RULES.find(([, matches]) => matches(value))?.[0] ?? "other";
};

export interface ScannedProcess extends ParsedProcStat {
    readonly pid: number;
    // The conversation its stamp names; undefined for unstamped work.
    readonly owner: string | undefined;
    readonly stamps?: ProcessStamps | undefined;
    readonly role: ProcessRole;
    readonly program: string | undefined;
}

export interface ProcSource {
    readonly listPids: () => Promise<readonly number[]>;
    readonly readText: ReadText;
}

// `key` is start time and comm, so a reused pid or a renaming exec is read again.
type Identity = Pick<ScannedProcess, "owner" | "stamps" | "role" | "program"> & { readonly key: string };

// Scans every process but `except`, keeping what each was found to be for the next scan.
export const createProcessScanner = (source: ProcSource = { listPids, readText }): ((except?: number) => Promise<ScannedProcess[]>) => {
    const identities = new Map<number, Identity>();
    const identify = async (pid: number, stat: ParsedProcStat): Promise<Identity> => {
        const key = `${stat.startTimeTicks ?? ""}:${stat.comm}`;
        const known = identities.get(pid);
        if (known?.key === key) {
            return known;
        }
        const [environ, cmdline, cgroup] = await Promise.all([
            source.readText(`/proc/${pid}/environ`),
            source.readText(`/proc/${pid}/cmdline`),
            source.readText(`/proc/${pid}/cgroup`),
        ]);
        const command = commandOf(stat.comm, cmdline ?? "");
        const identity = {
            key,
            owner: ownerOf(environ ?? ""),
            stamps: stampsOf(environ ?? ""),
            role: classifyProcess(command, cgroup ?? ""),
            program: programOf(command),
        };
        identities.set(pid, identity);
        return identity;
    };
    return async (except) => {
        const pids = (await source.listPids()).filter((pid) => pid !== except);
        const scanned: ScannedProcess[] = [];
        await mapPool(pids, READ_CONCURRENCY, async (pid) => {
            const text = await source.readText(`/proc/${pid}/stat`);
            const stat = text === undefined ? undefined : parseProcStat(text);
            // Exited between the listing and the read, the ordinary case during a scan.
            if (stat === undefined) {
                return;
            }
            const { owner, stamps, role, program } = await identify(pid, stat);
            scanned.push({ pid, ...stat, owner, stamps, role, program });
        });
        const alive = new Set(scanned.map((entry) => entry.pid));
        for (const pid of identities.keys()) {
            if (!alive.has(pid)) {
                identities.delete(pid);
            }
        }
        return scanned;
    };
};

// The daemon's one scanner: the gauge (live-metrics.ts), the minute log (resource-metrics.ts) and the reaper read the
// same processes, so they share what each process was found to be instead of reading every environ three times.
export const scanProcesses: (except?: number) => Promise<ScannedProcess[]> = createProcessScanner();
