import { EDGE_VERDICT_HEADER, edgeVerdictOf, type EdgeVerdict } from "@intentic/sandbox-contract";

// What Intentic's edge last said about each sandbox, kept where the connection machine can reach it. The edge is
// the only party that can tell "this box is not dialled in" from "your network is down", and it can only say so on a
// response — which the connection machine never sees, because oRPC hands it an error. So the answer is noted here as it
// passes through the one fetch every daemon call goes through.

// Past this, the last answer describes the past. The connect loop retries at most every 5s, so a live outage always has
// something fresher than this to say.
const FRESH_MS = 30_000;

interface Observation {
    readonly verdict: EdgeVerdict | undefined;
    readonly at: number;
}

// One slot per sandbox: the background polls of every other box in the fleet (fleetAcross, devicesAcross,
// changesAcross) pass through the same fetch, and with a single slot their answers overwrote the active box's verdict
// just before the connection machine read it, so a box the edge had called detached was diagnosed as a network fault.
const seen = new Map<string | undefined, Observation>();

// Records whatever the last response carried, INCLUDING nothing: a response with no verdict is a response from behind
// the edge (or from something that isn't ours), and either way the previous verdict has stopped describing the present.
export const noteEdgeVerdict = (sandboxId: string | undefined, response: Response): void => {
    seen.set(sandboxId, { verdict: edgeVerdictOf(response.headers.get(EDGE_VERDICT_HEADER)), at: Date.now() });
};

// A verdict read by a probe rather than a daemon call (diagnosis/probes.ts), so the connection machine classifies its
// next failure on it too.
export const noteVerdict = (sandboxId: string | undefined, verdict: EdgeVerdict): void => {
    seen.set(sandboxId, { verdict, at: Date.now() });
};

// The edge's word on this sandbox, if it is recent; undefined means the edge never spoke, which is the ordinary case
// for a loopback shortcut, a self-hosted address, and every healthy connection.
export const lastEdgeVerdict = (sandboxId: string | undefined, now = Date.now()): EdgeVerdict | undefined => {
    const observation = seen.get(sandboxId);
    return observation !== undefined && now - observation.at < FRESH_MS ? observation.verdict : undefined;
};

// Dropped on a sandbox switch, so nothing the edge said before it is read as the present.
export const forgetEdgeVerdict = (): void => {
    seen.clear();
};
