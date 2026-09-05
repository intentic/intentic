import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { errorMessage } from "@intentic/base/errors";
import type { Capability, CapabilityProbe } from "@intentic/sandbox-contract";
import { contributionFor, type ResolvedContribution } from "./contributions.js";

/* DID THESE SETTINGS ACTUALLY REACH THE THING, asked while the form is still on screen.
 *
 * Every failure this catches is otherwise discovered LATE and ILLEGIBLY: a token with the wrong scopes, an
 * instance URL that resolves nowhere from inside the container, a service that is not running, all present
 * afterwards as one card reading "not connected", with nothing saying which of six answers was wrong. One
 * request, made the way the connection itself would make it, turns each into a sentence beside the box that
 * caused it.
 *
 * WHAT IS TESTED IS DECLARED, NOT CODED. A cli card carries a `probe` (a URL template, headers, optionally where
 * in the answer the service names its caller), so a new connector is a manifest entry and no daemon change,
 * exactly as the card itself is. Two core kinds are handled here because their check is the PROTOCOL's rather
 * than any vendor's: a model endpoint lists its models, an MCP server answers `initialize`.
 *
 * NOTHING IS WRITTEN AND NOTHING IS APPLIED. The probe takes the config it was handed (with kept credentials
 * already resolved by the route) and touches no manifest, no file and no process: pressing Test can never be
 * the thing that changed the sandbox.
 *
 * node:https rather than fetch, the same reason trial.ts and platform-client.ts give: a self-signed certificate
 * is ORDINARY here (Obsidian's Local REST API ships one, so do most homelab services), and undici cannot skip
 * verification for a single request. */

// A probe is a question about reachability, not a job: a service that has not answered in this long is a
// service the reader needs to hear about now, with the timeout itself as the finding.
const PROBE_TIMEOUT_MS = 10_000;
// A probe reads only enough to name who answered: nobody's Test button should pull a megabyte of JSON.
const MAX_BODY_BYTES = 64 * 1024;

const template = (source: string, config: Record<string, unknown>): string =>
    source.replace(/\$\{([a-zA-Z][a-zA-Z0-9]*)(:uri)?\}/g, (_match, field: string, uri: string | undefined) => {
        const value = String(config[field] ?? "");
        return uri === undefined ? value : encodeURIComponent(value);
    });

// The name a service gives its caller, dug out of the JSON answer by the card's declared path. Missing is
// ordinary: not every service says who you are, and the message reads fine without it.
const identityIn = (body: unknown, path: string): string | undefined => {
    let node: unknown = body;
    for (const key of path.split(".")) {
        if (typeof node !== "object" || node === null) {
            return undefined;
        }
        node = (node as Record<string, unknown>)[key];
    }
    if (typeof node === "string" && node.length > 0) {
        return node;
    }
    return typeof node === "number" ? String(node) : undefined;
};

/* WHY A REQUEST DID NOT ARRIVE, in the reader's terms rather than node's. `ENOTFOUND` is the commonest answer
 * on this surface and the least useful printed raw: it means the host does not resolve, which here usually
 * means localhost was typed for a service living outside the container. */
const transportReason = (error: unknown): string => {
    const code = (error as { code?: string } | undefined)?.code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
        return "that host does not resolve from this sandbox";
    }
    if (code === "ECONNREFUSED") {
        return "nothing is listening there";
    }
    if (code === "ETIMEDOUT" || code === "ECONNRESET") {
        return "it did not answer in time";
    }
    if (code?.includes("CERT") === true || code === "ERR_TLS_CERT_ALTNAME_INVALID") {
        return "its certificate was refused";
    }
    return errorMessage(error);
};

// What an HTTP answer means for a credential, said once so every card refuses in the same words.
const httpReason = (status: number): string => {
    if (status === 401 || status === 403) {
        return "the credential was refused";
    }
    if (status === 404) {
        return "that address answered, but not with this service";
    }
    if (status >= 500) {
        return "the service itself is erroring";
    }
    return "the request was refused";
};

interface HttpProbe {
    readonly url: string;
    readonly method?: string | undefined;
    readonly headers?: Record<string, string> | undefined;
    readonly body?: string | undefined;
    readonly identity?: string | undefined;
    readonly insecure?: boolean | undefined;
    /** What to call the thing in the answer: "GitHub", "your model endpoint". */
    readonly subject: string;
}

interface RawAnswer {
    readonly status: number;
    readonly body: string;
}

const send = (url: URL, probe: HttpProbe): Promise<RawAnswer> =>
    new Promise((resolve, reject) => {
        const request = url.protocol === "http:" ? httpRequest : httpsRequest;
        const call = request(
            url,
            {
                method: probe.method ?? "GET",
                headers: {
                    accept: "application/json",
                    ...probe.headers,
                    ...(probe.body === undefined ? {} : { "content-type": "application/json" }),
                },
                rejectUnauthorized: probe.insecure !== true,
            },
            (response) => {
                let raw = "";
                response.on("data", (chunk: Buffer) => {
                    if (raw.length < MAX_BODY_BYTES) {
                        raw += chunk.toString();
                    }
                });
                response.on("end", () => resolve({ status: response.statusCode ?? 0, body: raw }));
            },
        );
        call.on("error", reject);
        call.setTimeout(PROBE_TIMEOUT_MS, () => call.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
        if (probe.body !== undefined) {
            call.write(probe.body);
        }
        call.end();
    });

const runHttpProbe = async (probe: HttpProbe): Promise<CapabilityProbe> => {
    let url: URL;
    try {
        url = new URL(probe.url);
    } catch {
        return { checked: true, ok: false, message: `"${probe.url}" is not an address this can be called at.` };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { checked: true, ok: false, message: `"${probe.url}" is not an http(s) address.` };
    }
    let answer: RawAnswer;
    try {
        answer = await send(url, probe);
    } catch (error) {
        return { checked: true, ok: false, message: `Could not reach ${url.host}: ${transportReason(error)}.` };
    }
    if (answer.status < 200 || answer.status >= 300) {
        return { checked: true, ok: false, message: `${probe.subject} answered ${answer.status}: ${httpReason(answer.status)}.` };
    }
    const reached = `Reached ${probe.subject}: it answered as itself.`;
    if (probe.identity === undefined) {
        return { checked: true, ok: true, message: reached };
    }
    let body: unknown;
    try {
        body = JSON.parse(answer.body);
    } catch {
        return { checked: true, ok: true, message: reached };
    }
    const who = identityIn(body, probe.identity);
    return { checked: true, ok: true, message: who === undefined ? reached : `Reached ${probe.subject}, authenticated as ${who}.` };
};

/* NOT TESTABLE IS NOT A FAILURE, and the two must never be drawn alike: an ssh box, a paired device and a
 * signed-in browser are all connections whose check is the thing itself, and a red "could not verify" on one
 * would be the form inventing a problem. */
const NO_TEST: CapabilityProbe = {
    checked: false,
    ok: false,
    message: "This one can't be tested from here: add it, and its card will tell you where it stands.",
};

// The card's declared probe, filled in from the answers on the form.
const contributionProbe = (contribution: ResolvedContribution | undefined, config: Record<string, unknown>): CapabilityProbe | HttpProbe => {
    const spec = contribution?.spec;
    if (spec === undefined || spec.kind !== "cli" || spec.probe === undefined) {
        return NO_TEST;
    }
    const declared = spec.probe;
    return {
        url: template(declared.url, config),
        method: declared.method,
        headers: Object.fromEntries(Object.entries(declared.headers ?? {}).map(([key, value]) => [key, template(value, config)])),
        identity: declared.identity,
        insecure: declared.insecure,
        subject: spec.catalog.name,
    };
};

/* The two kinds whose test is the PROTOCOL's rather than a vendor's, so they are core: a model endpoint serves
 * a model list, an MCP server answers `initialize` with its name. Both are exactly what the thing consuming
 * the connection does first, so a pass here means the next turn will work rather than merely that something is
 * listening on the port. */
const coreProbe = (capability: Capability): CapabilityProbe | HttpProbe => {
    const config = capability.config as Record<string, unknown>;
    if (capability.kind === "endpoint") {
        const base = String(config["baseUrl"] ?? "").replace(/\/+$/u, "");
        const anthropic = config["protocol"] === "anthropic";
        const key = String(config["apiKey"] ?? "");
        return {
            url: `${base}/models`,
            headers: key === "" ? {} : anthropic ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${key}` },
            subject: "your model endpoint",
        };
    }
    if (capability.kind === "mcp") {
        const token = String(config["token"] ?? "");
        return {
            url: String(config["url"] ?? ""),
            method: "POST",
            headers: {
                accept: "application/json, text/event-stream",
                ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "intentic-probe", version: "1" } },
            }),
            identity: "result.serverInfo.name",
            subject: "the MCP server",
        };
    }
    return NO_TEST;
};

/* Test one capability's settings. `registry` is the contribution registry the caller already built (the route
 * has it in hand), so this stays a function of its inputs and can be pinned without a daemon around it. */
export const probeCapability = async (registry: Map<string, ResolvedContribution>, capability: Capability): Promise<CapabilityProbe> => {
    const config = capability.config as Record<string, unknown>;
    const plan = capability.kind === "cli" ? contributionProbe(contributionFor(registry, capability.kind, config), config) : coreProbe(capability);
    return "checked" in plan ? plan : runHttpProbe(plan);
};
