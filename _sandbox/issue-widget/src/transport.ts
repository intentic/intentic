import type { IssueAccepted, IssueChallenge, IssuePublicConfig, IssueIngest } from "@intentic/sandbox-contract";

/* The SDK's half of the wire. Three calls against the sandbox daemon's public /intake routes, all subject to
 * its origin allowlist, so a rejected origin is the FIRST thing a misconfigured embed hits and every failure
 * here carries the server's own sentence rather than a status code.
 *
 * NOTHING HERE THROWS AT THE PAGE. A reporter that breaks the site it is reporting on is worse than no
 * reporter, so every path resolves, and `send` answers with a boolean the dialog can act on. */

export interface Endpoint {
    readonly base: string;
    readonly automationId: string;
}

const url = ({ base, automationId }: Endpoint, path: string): string => `${base}/intake/${encodeURIComponent(automationId)}/${path}`;

// What the server said when it refused. The daemon answers every refusal as {"error": "..."}, and that sentence
// is shown verbatim where a person can see it: "origin not allowed" tells a site owner exactly what to fix and
// anything invented here would not.
export class IntakeError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = "IntakeError";
    }
}

const failure = async (response: Response): Promise<IntakeError> => {
    const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
    return new IntakeError(typeof body?.error === "string" ? body.error : `request failed (${response.status})`, response.status);
};

export const fetchConfig = async (endpoint: Endpoint): Promise<IssuePublicConfig> => {
    const response = await fetch(url(endpoint, "config"));
    if (!response.ok) {
        throw await failure(response);
    }
    return (await response.json()) as IssuePublicConfig;
};

// The challenge is minted FOR one client: the daemon signs the client id into the salt, so a solution cannot be
// carried to another reporter. Hence the id in the query rather than a bare GET.
export const fetchChallenge = async (endpoint: Endpoint, clientId: string): Promise<IssueChallenge> => {
    const response = await fetch(`${url(endpoint, "challenge")}?client=${encodeURIComponent(clientId)}`);
    if (!response.ok) {
        throw await failure(response);
    }
    return (await response.json()) as IssueChallenge;
};

/* Send one report.
 *
 * `keepalive` is the whole reason a crash gets reported at all: the page is usually unloading (a crash is often
 * followed by a navigation or a reload), and an ordinary fetch is cancelled when the document goes away. With
 * it the browser hands the request to the network stack and lets it finish without the page. The cost is a hard
 * 64 kB body limit in every implementation, which is why the ingest schema's own bounds are well under that.
 *
 * sendBeacon would survive unload too, but it cannot set a content-type the daemon parses as JSON without
 * turning the request into a CORS preflight it also cannot answer, so keepalive is the one that works. */
export const send = async (endpoint: Endpoint, body: IssueIngest): Promise<IssueAccepted> => {
    const response = await fetch(url(endpoint, "report"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
    });
    if (!response.ok) {
        throw await failure(response);
    }
    return (await response.json()) as IssueAccepted;
};
