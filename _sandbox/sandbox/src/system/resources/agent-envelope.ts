import { join } from "node:path";
import { COST_BYTES } from "@intentic/constants/memory-room";
import type { ProcessRole } from "@intentic/sandbox-contract/schemas/metrics";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";

/* WHAT ONE AGENT HOLDS OVER ITS TURN, LEARNED FROM THE AGENTS THAT RAN HERE (2026-11-25, the shinobi-society audit). An
   agent turn was priced at a flat 1 GiB, held 90 s, and after that the gate trusted the reading: sixteen subagents of two
   parents were let in as fast as they were spawned, since each runtime is ~250 MiB when it starts. Over two days there,
   60 agents' minutes said what a turn really holds: 0.31 GiB at the median minute, 0.73 GiB at a typical agent's
   90th-percentile minute, and peaks of 5 to 12 GiB, mostly builds the queue prices on its own (queue/command-peaks.ts).

   So each agent's footprint is read off the minute's process scan (resource-metrics.ts): everything stamped with its
   conversation (its runtime, MCP servers and the commands it runs outside the queue), less what the heavy-command queue
   covers (process-scan.ts `queued`), which it admits and prices one command at a time. Sampled only while the conversation has a live turn and
   its runtime runs here: an idle runtime between turns would teach the envelope that turns are lighter than they are,
   and a child placed on a runner holds nothing here. An agent not seen for GONE_MS has ended, and its 90th-percentile
   minute joins the last AGENTS_KEPT, kept on /history so a restart does not forget them. The envelope is the
   ENVELOPE_QUANTILE of those: what the memory gate holds for each running agent turn (workload/resource-budget.ts, its
   lease), and prices the next one at. Until MEASURED_BEFORE_LEARNED agents have been measured it is the class's price. */

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
// The last agents whose footprint the envelope is made of, and how long one counts.
const AGENTS_KEPT = 50;
const AGENT_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
// Minutes an agent must have been seen for before its footprint is one; a turn shorter than that never grew.
const MIN_SAMPLES = 3;
// How long an agent unseen has ended; a turn that pauses on a slow provider keeps its runtime and its samples.
const GONE_MS = 5 * 60_000;
// The minutes kept of one agent: its last ten hours at a sample a minute.
const SAMPLES_PER_AGENT = 600;
// Measured agents below which the envelope stays the class's price.
export const MEASURED_BEFORE_LEARNED = 8;
// Within one agent, its heavier minutes; across agents, the heavier ones, since a lease that fits the median agent
// leaves every heavier one growing into memory the gate thought free.
const AGENT_QUANTILE = 0.9;
const ENVELOPE_QUANTILE = 0.75;
// Never below a runtime's own start, never above what would let a sandbox of 16 GiB run only three agent turns: one
// sandbox whose agents all run a heavy script outside the queue should queue that script, not stop fanning out.
const ENVELOPE_FLOOR_BYTES = 256 * MIB;
const ENVELOPE_CEILING_BYTES = 4 * GIB;
// Owners that are not a conversation: the daemon's own work and what nobody stamped.
const NOT_AGENTS = new Set(["daemon", "one-shot", "unstamped"]);

const AgentSchema = z.object({ mib: z.number().int().nonnegative(), at: z.number().int().nonnegative() });
const FileSchema = z.object({ agents: z.array(AgentSchema).default([]) });
type MeasuredAgent = z.infer<typeof AgentSchema>;

export const agentEnvelopesDocument = defineDocument({
    root: "history",
    path: "agent-envelopes.json",
    portability: "carry",
    schema: FileSchema,
});

/** One process of the minute's scan, as much of it as a footprint needs (resource-metrics.ts ProcessRow). */
export interface FootprintRow {
    readonly owner?: string | undefined;
    readonly role?: ProcessRole | undefined;
    // Covered by the heavy-command queue, which prices it on its own.
    readonly queued?: boolean | undefined;
    readonly rssBytes: number;
    readonly swapBytes: number;
}

/** What one agent turn is expected to hold, and from how many measured agents; `learnedFrom` 0 is the class's price. */
export interface Envelope {
    readonly bytes: number;
    readonly learnedFrom: number;
}

export interface AgentEnvelope {
    // Folds one scan in: the footprint, this minute, of each conversation with a live turn whose runtime runs here.
    readonly observe: (rows: readonly FootprintRow[], live: ReadonlySet<string>, at: number) => Promise<void>;
    readonly envelope: () => Envelope;
    // What each agent with a live turn held at the last scan, by conversation: only those whose runtime runs here.
    readonly footprints: (live: ReadonlySet<string>) => ReadonlyMap<string, number>;
}

/** The value at quantile `q` of `values` (nearest rank); undefined for none. */
export const quantileOf = (values: readonly number[], q: number): number | undefined => {
    if (values.length === 0) {
        return undefined;
    }
    const sorted = values.toSorted((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
};

/** The envelope the measured agents make: the class's price until enough were measured, else their heavier agents' share. */
export const envelopeOf = (agents: readonly Pick<MeasuredAgent, "mib">[]): Envelope => {
    const learned = quantileOf(
        agents.map((agent) => agent.mib * MIB),
        ENVELOPE_QUANTILE,
    );
    return agents.length < MEASURED_BEFORE_LEARNED || learned === undefined
        ? { bytes: COST_BYTES.agentRuntime, learnedFrom: 0 }
        : { bytes: Math.min(ENVELOPE_CEILING_BYTES, Math.max(ENVELOPE_FLOOR_BYTES, learned)), learnedFrom: agents.length };
};

/** Each conversation's footprint in one scan: its processes but the queued ones, for those with a runtime among them. */
export const agentFootprints = (rows: readonly FootprintRow[]): Map<string, number> => {
    const runtimes = new Set(rows.flatMap((row) => (row.role === "agentRuntime" && row.owner !== undefined ? [row.owner] : [])));
    const footprints = new Map<string, number>();
    for (const row of rows) {
        if (row.owner === undefined || !runtimes.has(row.owner) || NOT_AGENTS.has(row.owner) || row.queued === true) {
            continue;
        }
        footprints.set(row.owner, (footprints.get(row.owner) ?? 0) + row.rssBytes + row.swapBytes);
    }
    return footprints;
};

interface Watched {
    readonly samples: number[];
    lastSeen: number;
}

/** The learner over a store of measured agents; `store` undefined keeps them in memory only (a suite, a daemon with no history). */
export const createAgentEnvelope = (store?: {
    readonly read: () => Promise<readonly MeasuredAgent[]>;
    readonly write: (agents: readonly MeasuredAgent[]) => Promise<void>;
}): AgentEnvelope => {
    const watched = new Map<string, Watched>();
    let latest = new Map<string, number>();
    let measured: MeasuredAgent[] = [];
    // allow(silent-catch): measured agents that cannot be read are relearned; until then the envelope is the class's price
    const loaded = (store?.read() ?? Promise.resolve([])).then((agents) => {
        measured = [...agents, ...measured].slice(-AGENTS_KEPT);
    }, () => undefined);

    const settle = async (at: number): Promise<void> => {
        const ended: MeasuredAgent[] = [];
        for (const [owner, agent] of watched) {
            if (at - agent.lastSeen < GONE_MS) {
                continue;
            }
            watched.delete(owner);
            const heavy = agent.samples.length >= MIN_SAMPLES ? quantileOf(agent.samples, AGENT_QUANTILE) : undefined;
            if (heavy !== undefined) {
                ended.push({ mib: Math.round(heavy / MIB), at });
            }
        }
        if (ended.length === 0) {
            return;
        }
        await loaded;
        measured = [...measured.filter((agent) => at - agent.at <= AGENT_MAX_AGE_MS), ...ended].slice(-AGENTS_KEPT);
        await store?.write(measured);
    };

    return {
        observe: async (rows, live, at) => {
            latest = agentFootprints(rows);
            for (const [owner, bytes] of latest) {
                if (!live.has(owner)) {
                    continue;
                }
                const agent = watched.get(owner) ?? { samples: [], lastSeen: at };
                agent.samples.push(bytes);
                agent.samples.splice(0, Math.max(0, agent.samples.length - SAMPLES_PER_AGENT));
                agent.lastSeen = at;
                watched.set(owner, agent);
            }
            await settle(at);
        },
        envelope: () => envelopeOf(measured),
        footprints: (live) => new Map([...latest].filter(([owner]) => live.has(owner))),
    };
};

/** The learner, its measured agents kept on /history (agent-envelopes.json). */
export const fileAgentEnvelope = (historyRoot: string): AgentEnvelope => {
    const file = openDocument(agentEnvelopesDocument, join(historyRoot, agentEnvelopesDocument.path), { fallback: () => ({ agents: [] }) });
    return createAgentEnvelope({
        read: async () => (await file.read()).agents,
        write: async (agents) => {
            await file.update(() => ({ agents: [...agents] }));
        },
    });
};
