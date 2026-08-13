import { request } from "node:https";
import { ServiceRunReceiptSchema, type ServiceRunReceipt } from "@intentic/sandbox-contract";
import type { Config } from "../env.config.js";

/* THE SERVICES RELAY — the daemon's door onto the platform's metered service runs.
 *
 * The daemon adds exactly one thing here: the connect token, which is the credential that names whose
 * membership pays and which the platform refuses everything without. Everything else — the member gate, the
 * credit meter, the spend-then-refund, the signed forward to the provider — is the platform's job, and the
 * relay carries its answers through untouched, because a refusal like `insufficient_credits` is ALREADY
 * written for the person who will read it, and a daemon that rewrote it would only blur who said what. The
 * one thing the relay reads rather than carries is a run's NDJSON stream, which it forks: progress to the
 * transcript, the answer to the agent (relayServiceRun below).
 *
 * This is the route surface an extension backend declares in `permissions.daemon` — a glob like
 * "POST /pool/services/<one segment>/run" — so which services an extension may spend the owner's credits on
 * is in its manifest, diffable, and approved at install like every other reach it has.
 *
 * node:https for the platform-client.ts reason: a dev platform is a self-signed cert on
 * host.docker.internal, and undici cannot skip verification for one request only. */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "host.docker.internal"]);

export interface RelayedAnswer {
    readonly status: number;
    readonly body: string;
    readonly contentType: string;
    // The platform's advisory credits header on a served run (x-intentic-credits-remaining) — what the CLI's
    // receipt line and the offer card's receipt render. Absent when the platform sent none (a refusal, the
    // catalog). Its presence is also the one honest "this run was CHARGED" signal: the platform sets it
    // exactly when a forward served, so the receipt reads it rather than re-deriving spend from status codes.
    readonly remaining?: string;
}

// The daemon's own sentence for a sandbox with no platform — the one answer that can't be relayed.
const UNRELAYABLE: RelayedAnswer = {
    status: 502,
    body: JSON.stringify({ error: "this sandbox is not connected to a platform, and premium services need one" }),
    contentType: "application/json",
};

const relay = (config: Config, method: "GET" | "POST", path: string, payload?: string): Promise<RelayedAnswer> =>
    new Promise((resolve) => {
        if (config.platform.url === "" || config.connectToken === "") {
            resolve(UNRELAYABLE);
            return;
        }
        const url = new URL(path, config.platform.url);
        const req = request(
            url,
            {
                method,
                headers: {
                    "x-intentic-connect": config.connectToken,
                    ...(payload !== undefined ? { "content-type": "application/json" } : {}),
                },
                rejectUnauthorized: !LOCAL_HOSTS.has(url.hostname),
            },
            (response) => {
                let raw = "";
                response.on("data", (chunk: Buffer) => {
                    raw += chunk.toString();
                });
                response.on("end", () => {
                    const remaining = response.headers["x-intentic-credits-remaining"];
                    resolve({
                        status: response.statusCode ?? 502,
                        body: raw,
                        contentType: response.headers["content-type"] ?? "application/json",
                        ...(typeof remaining === "string" ? { remaining } : {}),
                    });
                });
            },
        );
        req.on("error", () =>
            resolve({
                status: 502,
                body: JSON.stringify({ error: "the platform could not be reached — nothing was charged" }),
                contentType: "application/json",
            }),
        );
        // Catalog reads only (runs stream through relayServiceRun below): quick, so cut a dead platform short.
        req.setTimeout(30_000, () => req.destroy(new Error("timeout")));
        req.end(payload);
    });

// The catalog + the owner's meter, as the platform states them.
export const relayServiceCatalog = (config: Config): Promise<RelayedAnswer> => relay(config, "GET", "/pool/services");

export interface RelayedRunAnswer extends RelayedAnswer {
    // The run reached the platform's stream — set even when the stream then broke, so a consumer can tell "a
    // stream without a receipt" (charge unknowable here) from a plain buffered refusal (charge as stated).
    readonly streamed?: true;
    // The platform's receipt trailer — the ledger's own last word on how a streamed run settled, carried
    // whole so the transcript receipt states what the platform did, never a guess.
    readonly receipt?: ServiceRunReceipt;
}

// The daemon's sentence for a stream that broke before its result — the one outcome where the charge is the
// platform's to know and this side honestly cannot say.
const BROKEN_STREAM: RelayedRunAnswer = {
    status: 502,
    body: JSON.stringify({
        error: { type: "service_unavailable", message: "The service stream broke before an answer arrived. Please try again shortly." },
    }),
    contentType: "application/json",
    streamed: true,
};

/* ONE METERED RUN, RELAYED LIVE. The slug rides the path; the body is the service's own JSON, untouched.
 *
 * The platform answers a run that reached a provider as an NDJSON stream — validated ServiceStreamEvents,
 * then its own `receipt` trailer — and this relay is where the stream FORKS: `status` lines surface through
 * `onStatus` the moment they arrive (the gate turns them into transcript frames under the offer card), while
 * the `result` is buffered into one JSON answer for the calling agent, because a model acts on the answer,
 * not the progress. Everything that is not a stream (the platform's refusals, a provider's paid 4xx) buffers
 * verbatim exactly as before. A refunded trailer becomes the platform's own no-answer-no-charge sentence, so
 * every caller reads one shape of refusal. */
export const relayServiceRun = (config: Config, slug: string, body: string, onStatus?: (text: string) => void): Promise<RelayedRunAnswer> =>
    new Promise((resolve) => {
        if (config.platform.url === "" || config.connectToken === "") {
            resolve(UNRELAYABLE);
            return;
        }
        const url = new URL(`/pool/services/${encodeURIComponent(slug)}/run`, config.platform.url);
        const req = request(
            url,
            {
                method: "POST",
                headers: { "x-intentic-connect": config.connectToken, "content-type": "application/json" },
                rejectUnauthorized: !LOCAL_HOSTS.has(url.hostname),
            },
            (response) => {
                const contentType = response.headers["content-type"] ?? "application/json";
                if (!contentType.includes("x-ndjson")) {
                    // Not a stream: a refusal or a provider's paid 4xx, buffered and relayed verbatim.
                    let raw = "";
                    response.on("data", (chunk: Buffer) => {
                        raw += chunk.toString();
                    });
                    response.on("end", () => {
                        const remaining = response.headers["x-intentic-credits-remaining"];
                        resolve({
                            status: response.statusCode ?? 502,
                            body: raw,
                            contentType,
                            ...(typeof remaining === "string" ? { remaining } : {}),
                        });
                    });
                    return;
                }
                let buffered = "";
                let result: string | undefined;
                let receipt: ServiceRunReceipt | undefined;
                // One platform-validated line. Anything that still fails to parse is a truncated tail from a
                // dying connection — skipped, and the missing receipt then says how the run settles.
                const line = (text: string): void => {
                    const trimmed = text.trim();
                    if (trimmed === "") {
                        return;
                    }
                    try {
                        const event = JSON.parse(trimmed) as { event?: string; text?: unknown; data?: unknown };
                        if (event.event === "status" && typeof event.text === "string") {
                            onStatus?.(event.text);
                        } else if (event.event === "result") {
                            result = JSON.stringify(event.data);
                        } else if (event.event === "receipt") {
                            const parsed = ServiceRunReceiptSchema.safeParse(event);
                            receipt = parsed.success ? parsed.data : undefined;
                        }
                    } catch {
                        /* skipped — see above */
                    }
                };
                response.on("data", (chunk: Buffer) => {
                    buffered += chunk.toString();
                    let newline = buffered.indexOf("\n");
                    while (newline !== -1) {
                        line(buffered.slice(0, newline));
                        buffered = buffered.slice(newline + 1);
                        newline = buffered.indexOf("\n");
                    }
                });
                response.on("end", () => {
                    line(buffered);
                    if (receipt !== undefined && receipt.outcome === "refunded") {
                        resolve({
                            status: 502,
                            body: JSON.stringify({
                                error: {
                                    type: "service_unavailable",
                                    message: "The service did not answer — nothing was charged. Please try again shortly.",
                                },
                            }),
                            contentType: "application/json",
                            streamed: true,
                            receipt,
                        });
                        return;
                    }
                    if (result === undefined) {
                        resolve({ ...BROKEN_STREAM, ...(receipt !== undefined ? { receipt } : {}) });
                        return;
                    }
                    resolve({
                        status: 200,
                        body: result,
                        contentType: "application/json",
                        streamed: true,
                        ...(receipt?.remaining !== undefined ? { remaining: String(receipt.remaining) } : {}),
                        ...(receipt !== undefined ? { receipt } : {}),
                    });
                });
                // A connection dying mid-stream ends here without an `end` — the broken-stream answer, with
                // whatever the trailer had said by then.
                response.on("error", () => resolve({ ...BROKEN_STREAM, ...(receipt !== undefined ? { receipt } : {}) }));
            },
        );
        req.on("error", () =>
            resolve({
                status: 502,
                body: JSON.stringify({ error: "the platform could not be reached — nothing was charged" }),
                contentType: "application/json",
            }),
        );
        // The platform's own stream budget is five minutes; this is a socket-idle bound just past it, so the
        // platform's refunded trailer (or its timeout refusal) always outruns a blunter local cut.
        req.setTimeout(315_000, () => req.destroy(new Error("timeout")));
        req.end(body);
    });
