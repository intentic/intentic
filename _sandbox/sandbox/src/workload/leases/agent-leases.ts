import type { MemoryReading, RoomJudgement } from "@intentic/constants/memory-room";
import { PERSON_RESERVE_BYTES } from "@intentic/constants/memory-room";

/* EVERY AGENT TURN RUNNING HERE HOLDS A LEASE ON WHAT IT IS EXPECTED TO GROW INTO (2026-11-25, the shinobi-society audit).
   An agent turn was priced at 1 GiB, held 90 s, and from then on the gate trusted the reading of the moment: sixteen
   subagents of two parents went in as fast as they were spawned, since each runtime starts at ~250 MiB, and what they
   then ran filled the sandbox until the memory guard killed a build. Now each agent turn running here holds its envelope
   (system/resources/agent-envelope.ts: what agents here held at their heavier minutes, learned from the last fifty) for
   as long as its turn lives, less what it already holds, and one more agent turn nobody waits on starts only where every
   lease and its own still fit beside a person's turn (../resource-budget.ts). That is the sandbox-wide ceiling on agents at
   once, sized by what agents here measure rather than by a count, and the snapshot says how many more fit now
   (`agentRoomOf`). A person's turn and a heavy command are judged as before: a person is never held, and a command is
   priced by the queue on its own. */

const GIB = 1024 ** 3;
const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

export interface AgentLeases {
    // What one agent turn is expected to hold, and from how many measured agents (0: the class's price).
    readonly envelopeBytes: number;
    readonly learnedFrom: number;
    // Each agent turn live here, by its conversation, with what it held at the last scan; one on a runner is not here.
    readonly agents: ReadonlyMap<string, number>;
}
export type LeaseSource = () => AgentLeases | undefined;

/** Where the leases come from, handed over at boot once the conversations exist (bootstrap/boot-schedulers.ts). */
export interface LeaseSlot {
    readonly read: LeaseSource;
    readonly answerToLeases: (source: LeaseSource) => void;
}
export const leaseSlot = (): LeaseSlot => {
    let source: LeaseSource | undefined;
    return {
        read: () => {
            try {
                return source?.();
            } catch {
                // allow(silent-catch): leases that cannot be read hold nothing, and the gate judges as it did before them
                return undefined;
            }
        },
        answerToLeases: (next) => {
            source = next;
        },
    };
};

// What a request is, as much as the leases ask of it.
interface LeaseAsk {
    readonly workload: string;
    readonly attended: boolean;
    readonly owner?: string | undefined;
    readonly where?: unknown;
}

/** What the leases ask of one agent turn nobody waits on: its own price, and what every other agent turn here still holds. */
export interface Lease {
    readonly costBytes: number;
    readonly heldBytes: number;
    readonly agents: number;
    readonly learnedFrom: number;
    // Every leased conversation, whose timed reservation the lease now stands for.
    readonly owners: ReadonlySet<string>;
}

/** An agent turn nobody waits on, starting here: the only work leases judge, and the host's minute speaks for. */
export const leasedTurn = (request: LeaseAsk): boolean =>
    request.workload === "agentRuntime" && !request.attended && (request.where === undefined || request.where === "local");

export const leaseFor = (request: LeaseAsk, leases: AgentLeases | undefined): Lease | undefined => {
    if (leases === undefined || !leasedTurn(request)) {
        return undefined;
    }
    let heldBytes = 0;
    let agents = 0;
    for (const [owner, footprintBytes] of leases.agents) {
        if (owner !== request.owner) {
            agents += 1;
            heldBytes += Math.max(0, leases.envelopeBytes - footprintBytes);
        }
    }
    return { costBytes: leases.envelopeBytes, heldBytes, agents, learnedFrom: leases.learnedFrom, owners: new Set(leases.agents.keys()) };
};

/** Why an agent turn waits when the leases are what fill the room, for its row and its parent. */
export const leaseWords = (lease: Lease, judged: RoomJudgement): string => {
    const learned = lease.learnedFrom > 0 ? `the heavier minutes of the last ${String(lease.learnedFrom)} agents here` : "the default until agents here are measured";
    const left = judged.freeBytes === undefined ? "" : `, which leaves ${gib(judged.freeBytes)}`;
    const turns = `${String(lease.agents)} agent turn${lease.agents === 1 ? "" : "s"} running here`;
    return `Sandbox memory is spoken for: ${turns} may each grow to ${gib(lease.costBytes)} (${learned}), so ${gib(lease.heldBytes)} is kept for them${left} of the ${gib(judged.needBytes)} one more needs beside a person's turn`;
};

/** The agent turns holding leases, and how many more agent turns nobody waits on fit beside them now, by bytes alone. */
export interface AgentRoom {
    readonly running: number;
    readonly envelopeBytes: number;
    readonly learnedFrom: number;
    readonly heldBytes: number;
    // Undefined where nothing measures free memory.
    readonly fit: number | undefined;
}

/** `free` is free memory before any reservation; `reservedBytes` what admitted work still holds off it. */
export const agentRoomOf = (leases: AgentLeases | undefined, free: number | undefined, reservedBytes: number): AgentRoom | undefined => {
    const lease = leaseFor({ workload: "agentRuntime", attended: false }, leases);
    if (lease === undefined) {
        return undefined;
    }
    const room = free === undefined ? undefined : free - reservedBytes - lease.heldBytes - PERSON_RESERVE_BYTES;
    return {
        running: lease.agents,
        envelopeBytes: lease.costBytes,
        learnedFrom: lease.learnedFrom,
        heldBytes: lease.heldBytes,
        fit: room === undefined ? undefined : Math.max(0, Math.floor(room / lease.costBytes)),
    };
};

/* THE HOST'S ROOM AS ITS LAST MINUTE SAYS IT, for an agent turn nobody waits on (2026-11-25). On a Windows PC under WSL the
   host's available memory swung from 0.4 to 6 GiB from one minute to the next, and children started in the moments it
   read high, into a host that was below its floor half the time. The median of the last minute's readings is neither
   one high moment nor one low one. */
const HOST_STEADY_MS = 60_000;

type Taken = { readonly at: number; readonly reading: MemoryReading };

/** `taken` with the host's available memory the median of `recent` readings in the minute up to it. */
export const steadyHostOf = (taken: Taken, recent: readonly Taken[]): MemoryReading => {
    const { host } = taken.reading;
    if (host === undefined) {
        return taken.reading;
    }
    const seen = recent.flatMap((earlier) =>
        earlier.at >= taken.at - HOST_STEADY_MS && earlier.at <= taken.at && earlier.reading.host !== undefined ? [earlier.reading.host.availableBytes] : [],
    );
    const sorted = (seen.length === 0 ? [host.availableBytes] : seen).toSorted((left, right) => left - right);
    return { ...taken.reading, host: { ...host, availableBytes: sorted[Math.floor((sorted.length - 1) / 2)] ?? host.availableBytes } };
};
