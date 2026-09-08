import type { IssueAccepted, IssueIngest, IssuePublicConfig } from "@intentic/sandbox-contract";
import { embedFailure, type EmbedEndpoint, embedUrl, fetchEmbedChallenge, fetchEmbedJson, type PowChallenge } from "@intentic/sandbox-contract/embed";

// The three embed calls (config, challenge) are the contract's (embed.ts) against the daemon's public /intake door;
// sending the report is this SDK's own. `send` throws on failure; the client above swallows it, so nothing reaches the
// page.
const SLUG = "intake";

export const fetchConfig = (endpoint: EmbedEndpoint): Promise<IssuePublicConfig> => fetchEmbedJson<IssuePublicConfig>(embedUrl(endpoint, SLUG, "config"));

// The challenge is minted for one client: the daemon signs the client id into the salt, so a solution can't be reused
// elsewhere.
export const fetchChallenge = (endpoint: EmbedEndpoint, clientId: string): Promise<PowChallenge> => fetchEmbedChallenge(endpoint, SLUG, "client", clientId);

// `keepalive` survives the page unloading (an ordinary fetch would be cancelled); the ingest schema stays under the
// ~64kB keepalive body cap. `sendBeacon` can't set JSON content-type without an unanswerable preflight.
export const send = async (endpoint: EmbedEndpoint, body: IssueIngest): Promise<IssueAccepted> => {
    const response = await fetch(embedUrl(endpoint, SLUG, "report"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
    });
    if (!response.ok) {
        throw await embedFailure(response);
    }
    return (await response.json()) as IssueAccepted;
};
