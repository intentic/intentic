import { EDGE_VERDICT_HEADER, edgeVerdictOf, type EdgeVerdict } from "@intentic/sandbox-contract";

// What Intentic's edge last said about the active sandbox, kept where the connection machine can reach it. The edge is
// the only party that can tell "this box is not dialled in" from "your network is down", and it can only say so on a
// response — which the connection machine never sees, because oRPC hands it an error. So the answer is noted here as it
// passes through the one fetch every daemon call goes through.

// Past this, the last answer describes the past. The connect loop retries at most every 5s, so a live outage always has
// something fresher than this to say.
const FRESH_MS = 30_000;

interface Observation {
    readonly sandboxId: string | undefined;
    readonly verdict: EdgeVerdict | undefined;
    readonly at: number;
}

let seen: Observation | undefined;

// Records whatever the last response carried, INCLUDING nothing: a response with no verdict is a response from behind
// the edge (or from something that isn't ours), and either way the previous verdict has stopped describing the present.
export const noteEdgeVerdict = (sandboxId: string | undefined, response: Response): void => {
    seen = { sandboxId, verdict: edgeVerdictOf(response.headers.get(EDGE_VERDICT_HEADER)), at: Date.now() };
};

// The edge's word on this sandbox, if it is recent and about this sandbox; undefined means the edge never spoke, which
// is the ordinary case for a loopback shortcut, a self-hosted address, and every healthy connection.
export const lastEdgeVerdict = (sandboxId: string | undefined, now = Date.now()): EdgeVerdict | undefined =>
    seen !== undefined && seen.sandboxId === sandboxId && now - seen.at < FRESH_MS ? seen.verdict : undefined;

// Dropped on a sandbox switch, so the outgoing box's verdict can never be read as the incoming one's.
export const forgetEdgeVerdict = (): void => {
    seen = undefined;
};
