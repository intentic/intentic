// Whose work a process the daemon spawned is, stamped into its environment by every spawner (a turn's runtime, a
// browser, a helper call) and read back by the leftover sweep and the live metrics (platform/boot/leftovers.ts), so
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
