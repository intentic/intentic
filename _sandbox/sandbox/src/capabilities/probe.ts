import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { errorMessage } from "@intentic/base/errors";
import type { Capability, CapabilityProbe } from "@intentic/sandbox-contract";
import { contributionFor, type ResolvedContribution } from "./contributions.js";

// Checks whether a card's settings actually reach the service, turning a generic failure into a specific reason. A cli
// card declares its probe in the manifest; endpoint and mcp are handled directly since their check is the protocol
// itself. Read-only, and uses node:https since a self-signed certificate must not fail the request.

// A probe is about reachability, not a job: no answer within this long is itself the finding.
const PROBE_TIMEOUT_MS = 10_000;
// Enough to name who answered; a probe should not pull a large body.
const MAX_BODY_BYTES = 64 * 1024;

const template = (source: string, config: Record<string, unknown>): string =>
    source.replace(/\$\{([a-zA-Z][a-zA-Z0-9]*)(:uri)?\}/g, (_match, field: string, uri: string | undefined) => {
        const value = String(config[field] ?? "");
        return uri === undefined ? value : encodeURIComponent(value);
    });

// Digs the caller's name out of the JSON body via the card's declared dotted path; missing is ordinary.
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

// Maps a raw error code to the reader's terms; ENOTFOUND usually means localhost was typed for a service outside the
// container.
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

// What each HTTP status means for a credential, said once so every card refuses in the same words.
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

// Not tested is not a failure: an ssh box, paired device or signed-in browser has no test besides using it.
const NO_TEST: CapabilityProbe = {
    checked: false,
    ok: false,
    message: "This one can't be tested from here: add it, and its card will tell you where it stands.",
};

// Builds an HTTP probe from the card's declared template, using the submitted config values.
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

// endpoint and mcp are core: their check is the protocol itself (model list, `initialize`), so a pass means the next
// turn will work.
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

// `registry` is the contribution registry the caller already built, kept as a parameter so this stays a pure function
// of its inputs.
export const probeCapability = async (registry: Map<string, ResolvedContribution>, capability: Capability): Promise<CapabilityProbe> => {
    const config = capability.config as Record<string, unknown>;
    const plan = capability.kind === "cli" ? contributionProbe(contributionFor(registry, capability.kind, config), config) : coreProbe(capability);
    return "checked" in plan ? plan : runHttpProbe(plan);
};
