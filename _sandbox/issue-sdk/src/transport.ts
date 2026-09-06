import type { IssueAccepted, IssueIngest, IssuePublicConfig } from "@intentic/sandbox-contract";
import { embedFailure, type EmbedEndpoint, embedUrl, fetchEmbedChallenge, fetchEmbedJson, type PowChallenge } from "@intentic/sandbox-contract/embed";

/* The SDK's half of the wire: the three calls every embed makes are the contract's (embed.ts), against the
 * daemon's public /intake door; what is this SDK's own is the report.
 *
 * NOTHING HERE THROWS AT THE PAGE. A reporter that breaks the site it is reporting on is worse than no
 * reporter, so the client above resolves every path, and `send` answers with a boolean the dialog can act on. */
const SLUG = "intake";

export const fetchConfig = (endpoint: EmbedEndpoint): Promise<IssuePublicConfig> => fetchEmbedJson<IssuePublicConfig>(embedUrl(endpoint, SLUG, "config"));

// The challenge is minted FOR one client: the daemon signs the client id into the salt, so a solution cannot be
// carried to another reporter.
export const fetchChallenge = (endpoint: EmbedEndpoint, clientId: string): Promise<PowChallenge> => fetchEmbedChallenge(endpoint, SLUG, "client", clientId);

/* Send one report.
 *
 * `keepalive` is the whole reason a crash gets reported at all: the page is usually unloading (a crash is often
 * followed by a navigation or a reload), and an ordinary fetch is cancelled when the document goes away. With
 * it the browser hands the request to the network stack and lets it finish without the page. The cost is a hard
 * 64 kB body limit in every implementation, which is why the ingest schema's own bounds are well under that.
 *
 * sendBeacon would survive unload too, but it cannot set a content-type the daemon parses as JSON without
 * turning the request into a CORS preflight it also cannot answer, so keepalive is the one that works. */
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
