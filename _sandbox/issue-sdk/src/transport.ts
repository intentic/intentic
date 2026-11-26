import type { IssueAccepted, IssueIngest, IssuePublicConfig } from "@intentic/sandbox-contract/schemas/issues";
import { embedFailure, type EmbedEndpoint, fetchEmbedJson, type PowChallenge } from "@intentic/sandbox-contract/embed";

// The SDK's three calls against its intake's public door. Since 2026-11-26 that door is the issues extension's
// (/door/intentic.issues/…, served by its backend behind the sandbox's own protections), where the daemon's /intake/…
// was before; the daemon still forwards the old paths for an SDK built against them. `send` throws on failure; the
// client above swallows it, so nothing reaches the page.
export const DOOR = "door/intentic.issues";

// The headers the door reads a proof of work from (the sandbox contract's PUBLIC_DOOR_POW_HEADER and
// PUBLIC_DOOR_POW_CALLER_HEADER, spelled here since this bundle imports nothing that would drag zod in).
const POW_HEADER = "x-intentic-pow";
const POW_CALLER_HEADER = "x-intentic-pow-caller";

const intakeUrl = ({ base, automationId }: EmbedEndpoint, path: string): string => `${base}/${DOOR}/${encodeURIComponent(automationId)}/${path}`;

export const fetchConfig = (endpoint: EmbedEndpoint): Promise<IssuePublicConfig> => fetchEmbedJson<IssuePublicConfig>(intakeUrl(endpoint, "config"));

// The challenge is minted for one client: the sandbox signs the client id into the salt, so a solution can't be reused
// elsewhere.
export const fetchChallenge = (endpoint: EmbedEndpoint, clientId: string): Promise<PowChallenge> =>
    fetchEmbedJson<PowChallenge>(`${endpoint.base}/${DOOR}/~challenge?caller=${encodeURIComponent(clientId)}`);

// What the door wants beside the body: the intake's key for a client with no Origin (as `?key=`, which needs no header a
// preflight would have to allow), and a solved proof of work, which sends the report to the route that checks one.
export interface Credentials {
    readonly key?: string | undefined;
    readonly proof?: string | undefined;
}

// `keepalive` survives the page unloading (an ordinary fetch would be cancelled); the ingest schema stays under the
// ~64kB keepalive body cap. `sendBeacon` can't set JSON content-type without an unanswerable preflight.
export const send = async (endpoint: EmbedEndpoint, body: IssueIngest, credentials: Credentials = {}): Promise<IssueAccepted> => {
    const url = new URL(intakeUrl(endpoint, credentials.proof === undefined ? "report" : "written"));
    if (credentials.key !== undefined) {
        url.searchParams.set("key", credentials.key);
    }
    const headers = new Headers({ "content-type": "application/json" });
    if (credentials.proof !== undefined) {
        headers.set(POW_HEADER, credentials.proof);
        headers.set(POW_CALLER_HEADER, body.clientId);
    }
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), keepalive: true });
    if (!response.ok) {
        throw await embedFailure(response);
    }
    return (await response.json()) as IssueAccepted;
};
