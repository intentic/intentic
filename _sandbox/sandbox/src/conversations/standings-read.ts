import { within } from "@intentic/base/async";
import type { AgentsRegistry } from "./registry/agents-registry.js";

// How long a roster read waits on the standings it asks for before it answers with the ones in hand. The probe reads
// every live agent's branch against main, which on a disk gone cold over a long idle took seconds per repository, and
// the editor asks for the roster on every reconnect: the probe goes on, and what it changes reaches the board as a
// broadcast on /events (refreshStandings), so the read never has to wait it out (2026-10-27).
const ROSTER_STANDINGS_PATIENCE_MS = 2_000;

/** A roster read's refresh: the standings refreshed, or as they stand once ROSTER_STANDINGS_PATIENCE_MS has passed. */
export const standingsForRead = (agents: Pick<AgentsRegistry, "refreshStandings">, patienceMs = ROSTER_STANDINGS_PATIENCE_MS): Promise<void> =>
    within(agents.refreshStandings(), patienceMs, undefined);
