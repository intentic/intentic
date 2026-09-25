import { request } from "node:https";
import { errorMessage } from "@intentic/base/errors";
import type { Config } from "../env.config.js";
import { isLocalHost } from "./tls/local-tls.js";

// Every platform call is one exchange over node:https: undici can skip a dev platform's self-signed cert only process-wide.

export interface PlatformExchange {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly payload?: string;
    // Cuts a socket that has gone quiet this long, rejecting with `idleError`; `signal` bounds the whole exchange.
    readonly idleMs?: number;
    readonly idleError?: string;
    readonly signal?: AbortSignal;
}

export interface PlatformAnswer {
    readonly status: number;
    readonly body: string;
    readonly contentType: string | undefined;
}

// Resolves with whatever the platform answered, a refusal included; rejects only when it could not be reached.
export const exchangeWithPlatform = (config: Config, call: PlatformExchange): Promise<PlatformAnswer> =>
    new Promise((resolve, reject) => {
        const url = new URL(call.path, config.platform.url);
        const req = request(
            url,
            {
                method: call.method,
                headers: { ...call.headers, ...(call.payload === undefined ? {} : { "content-type": "application/json" }) },
                rejectUnauthorized: !isLocalHost(url.hostname),
                ...(call.signal === undefined ? {} : { signal: call.signal }),
            },
            (response) => {
                let raw = "";
                response.on("data", (chunk: Buffer) => {
                    raw += chunk.toString();
                });
                // A body cut off mid-read errors the response, not the request; unheard, it would be an uncaught error.
                response.on("error", reject);
                response.on("end", () => resolve({ status: response.statusCode ?? 0, body: raw, contentType: response.headers["content-type"] }));
            },
        );
        req.on("error", reject);
        if (call.idleMs !== undefined) {
            const idleError = call.idleError ?? "the platform did not respond in time";
            req.setTimeout(call.idleMs, () => req.destroy(new Error(idleError)));
        }
        req.end(call.payload);
    });

// The connect token names this sandbox; every call below is authenticated by possessing it.
const connectHeaders = (config: Config): Readonly<Record<string, string>> => ({ "x-intentic-connect": config.connectToken });

const jsonOf = (body: string): unknown => {
    try {
        return JSON.parse(body);
    } catch {
        // allow(silent-catch): an unparseable body is an answer without JSON, which every caller reads as undefined.
        return undefined;
    }
};

export interface PlatformResponse {
    readonly status: number;
    readonly json: unknown;
}

// POSTs and reads JSON back; rejects headless or after a quiet minute, so a silent platform can't hang its caller.
export const postToPlatform = async (config: Config, path: string, body: unknown): Promise<PlatformResponse> => {
    if (config.platform.url === "") {
        throw new Error("the platform URL is not configured for this sandbox");
    }
    const answer = await exchangeWithPlatform(config, { method: "POST", path, headers: connectHeaders(config), payload: JSON.stringify(body), idleMs: 60_000 });
    return { status: answer.status, json: jsonOf(answer.body) };
};

// GETs JSON with the connect token, the whole exchange bounded by `signal`.
export const getFromPlatform = async (config: Config, path: string, signal: AbortSignal): Promise<PlatformResponse> => {
    const answer = await exchangeWithPlatform(config, { method: "GET", path, headers: connectHeaders(config), signal });
    return { status: answer.status, json: jsonOf(answer.body) };
};

// A status is the platform's verdict, an error that it was unreachable; never rejects, since its callers retry.
export type PlatformReport = { readonly status: number } | { readonly error: string };

export const reportToPlatform = (config: Config, path: string, body: unknown): Promise<PlatformReport> =>
    exchangeWithPlatform(config, { method: "POST", path, headers: connectHeaders(config), payload: JSON.stringify(body) }).then(
        (answer): PlatformReport => ({ status: answer.status }),
        (error: unknown): PlatformReport => ({ error: errorMessage(error) }),
    );

// The owner's name for this sandbox and its switcher logo: held only by the platform, so a bundle must ask for them.
export interface SandboxPresentation {
    readonly name?: string;
    readonly image?: string;
}

// Best-effort, never a throw: an export must not fail because the platform is unreachable, headless or older.
export const fetchPresentation = async (config: Config): Promise<SandboxPresentation | undefined> => {
    try {
        const { status, json } = await postToPlatform(config, "/sandbox/presentation", {});
        if (status !== 200 || typeof json !== "object" || json === null) {
            return undefined;
        }
        const { name, image } = json as { name?: unknown; image?: unknown };
        const presentation: SandboxPresentation = {
            ...(typeof name === "string" && name !== "" ? { name } : {}),
            ...(typeof image === "string" && image !== "" ? { image } : {}),
        };
        return presentation.name === undefined && presentation.image === undefined ? undefined : presentation;
    } catch {
        // allow(silent-catch): best-effort by contract, see above.
        return undefined;
    }
};
