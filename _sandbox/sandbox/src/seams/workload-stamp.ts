import { randomBytes } from "node:crypto";
import { FRONT_SOCKET_ENV, NODE_SOCKET_ENV } from "@intentic/sandbox-contract/front-wire";

// Whose work a process the daemon spawned is, stamped into its environment by every spawner (a turn's runtime, a
// browser, a helper call) and read back by the process scan (system/resources/process-scan.ts), so
// neither side imports the other.

// The stamp naming whose work a process is; identity itself is the process group, not this env var.
export const WORKLOAD_ENV = "INTENTIC_TURN_OWNER";

// Env to spread into a spawned workload's environment; owner is a conversation id or one of the two reserved names
// below.
export const workloadStamp = (owner: string): Record<string, string> => ({ [WORKLOAD_ENV]: owner });

// The two owners that are not conversations: `daemon` for pooled ACP processes kept alive across turns, and `one-shot`
// for toolless maxTurns-1 helper calls nothing will ever report live.
export const DAEMON_OWNER = "daemon";
export const ONE_SHOT_OWNER = "one-shot";

// WHICH DAEMON RUN STARTED A PROCESS (2026-10-05). Set on the daemon's own environment at boot (adoptDaemonGeneration),
// so every child and everything it forks carries it; the boot sweep (system/boot/generation-sweep.ts) ends what an
// older run left behind. A fresh value every boot, never inherited: a daemon started from an agent's shell would
// otherwise carry its parent's.
export const DAEMON_GEN_ENV = "INTENTIC_DAEMON_GEN";
// What a detached child the daemon starts on its own account is, for the children no other stamp or sweep reaches
// (their own process group, so neither the front's group kill nor the leftover sweep's group test finds them).
export const DETACHED_ENV = "INTENTIC_DETACHED";
// Epoch ms past which a detached child with a deadline of its own is overdue, so the sweep ends it even when the
// daemon that set the deadline is gone.
export const DEADLINE_ENV = "INTENTIC_DEADLINE";

export const DETACHED_KINDS = [
    "isolation-anchor",
    "watch-check",
    "edit-rule",
    "login-browser",
    // The rest run through workload/run-check.ts, or are the extension backend host (its own group, killed as one).
    "automation-guard",
    "loop-check",
    "probe",
    "js-run",
    "python-check",
    "backend-host",
] as const;
export type DetachedKind = (typeof DETACHED_KINDS)[number];

const generation = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;

/** This daemon run's generation. */
export const daemonGeneration = (): string => generation;

/** Puts this run's generation on the daemon's own environment, for every child to inherit; once, before any spawn. */
export const adoptDaemonGeneration = (env: NodeJS.ProcessEnv = process.env): string => {
    env[DAEMON_GEN_ENV] = generation;
    return generation;
};

// What a detached child's environment carries on top of the daemon's.
export interface DetachedStampEnv {
    readonly [DETACHED_ENV]: DetachedKind;
    readonly [DAEMON_GEN_ENV]: string;
    readonly [DEADLINE_ENV]?: string;
}

/** Env for a detached child: what it is, this run's generation, and when it is overdue when it has a deadline. */
export const detachedStamp = (kind: DetachedKind, deadlineAt?: number): DetachedStampEnv => {
    const stamp = { [DETACHED_ENV]: kind, [DAEMON_GEN_ENV]: generation };
    return deadlineAt === undefined ? stamp : { ...stamp, [DEADLINE_ENV]: String(Math.ceil(deadlineAt)) };
};

// Variables only the daemon may hold: the front's control socket and the socket it relays HTTP to. A child that
// inherited them (an agent's shell, a second Node started there) could take the front's socket over.
export const DAEMON_ONLY_ENV = [FRONT_SOCKET_ENV, NODE_SOCKET_ENV] as const;
