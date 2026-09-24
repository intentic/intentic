import type { ProcessRole } from "@intentic/sandbox-contract";
import { classifyProcess } from "./process-scan.js";

// Who the kernel kills first when the sandbox runs out of memory, as oom_score_adj raised above the daemon's 0. The
// kernel counts 100 points as a tenth of the memory it weighs (limit plus swap), so a tier outranks any size gap short of
// that, and within one tier the biggest still goes first.

export const OOM_SCORE = {
    // A turn's own runtime: a person's, or the top of a fan-out whose loss orphans every child it supervises.
    turn: 100,
    // Added per spawn level, so a child goes before its parent and a grandchild before both.
    perSpawnLevel: 100,
    // A helper the daemon restarts or reopens (search engine, language server, browser): losing one costs a restart.
    service: 500,
    // An agent's shell command: the tool call ends 137 and the agent reads it.
    command: 600,
    // A build, test or typecheck: the peak consumer, and the cheapest thing to run again.
    heavy: 800,
} as const;

// Spawn levels that still rank below a service; anything deeper shares the last of them.
const RANKED_LEVELS = (OOM_SCORE.service - OOM_SCORE.turn) / OOM_SCORE.perSpawnLevel - 1;

const SERVICE_ROLES: ReadonlySet<ProcessRole> = new Set<ProcessRole>(["searchEngine", "languageServer", "translator", "extension", "localModel", "browser"]);

/** The score a process of this role earns, or undefined for one that stays with the daemon (git, terminals, the rest). */
export const oomScoreOf = (role: ProcessRole, spawnDepth: number): number | undefined => {
    if (role === "agentRuntime") {
        return OOM_SCORE.turn + OOM_SCORE.perSpawnLevel * Math.min(Math.max(0, spawnDepth), RANKED_LEVELS);
    }
    if (role === "toolchain") {
        return OOM_SCORE.heavy;
    }
    return SERVICE_ROLES.has(role) ? OOM_SCORE.service : undefined;
};

// Never lowered: a process that already ranks as killable as asked (Chrome raises its own renderers) keeps its own.
export const raisedScore = (current: number, wanted: number): number | undefined => (current >= wanted ? undefined : wanted);

// A direct child of the daemon as the scorer reads it: its command line and the conversation its stamp names.
export interface ScoredProcess {
    readonly command: string;
    readonly owner: string | undefined;
}

export type OomScoreResolver = (process: ScoredProcess) => number | undefined;

/** Resolves a process's score from its role, and its spawn depth from the conversation that owns it. */
export const oomScoreResolver =
    (spawnDepthOf: (conversationId: string) => number): OomScoreResolver =>
    ({ command, owner }) =>
        oomScoreOf(classifyProcess(command), owner === undefined ? 0 : spawnDepthOf(owner));

/** `choom` in front of a command line; util-linux ships it beside the `ionice` and `flock` the same wrappers run. */
export const choomPrefix = (score: number): string => `choom -n ${String(score)} -- `;
