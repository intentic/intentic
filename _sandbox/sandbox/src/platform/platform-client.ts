import { request } from "node:https";
import type { Config } from "../env.config.js";
import { isLocalHost } from "./tls/local-tls.js";

// A single authenticated POST to the platform, authenticated by possession of the connect token (the announce
// pattern). node:https instead of fetch: undici can't skip TLS verification per-request, and a localhost dev
// platform arrives as a self-signed cert on host.docker.internal, the process-global escape hatch would also
// disable verification for Google/Anthropic/OpenAI. Everything else verifies normally.

export interface PlatformResponse {
    readonly status: number;
    readonly json: unknown;
}

// How this sandbox presents itself, as the platform holds it: the owner's name for it and its switcher logo. Neither
// is workspace state, so the daemon has no other way to learn them, and a bundle cannot carry them without asking.
//
// Best-effort by contract, never a throw: this is read while packing an export, and an export must not fail because
// the platform is unreachable, headless, or older than this route. An absent answer just means the bundle carries no
// presentation and the target keeps its own.
export interface SandboxPresentation {
    readonly name?: string;
    readonly image?: string;
}

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
        return undefined;
    }
};

// POST `body` (JSON) to `path` on the configured platform with the connect token. Rejects if no platform URL is
// configured (headless/loopback). Resolves with the status + parsed JSON body (undefined when unparseable),
// the caller maps non-2xx to a user-facing error.
export const postToPlatform = (config: Config, path: string, body: unknown): Promise<PlatformResponse> =>
    new Promise((resolve, reject) => {
        if (config.platform.url === "") {
            reject(new Error("the platform URL is not configured for this sandbox"));
            return;
        }
        const url = new URL(path, config.platform.url);
        const payload = JSON.stringify(body);
        const req = request(
            url,
            {
                method: "POST",
                headers: { "content-type": "application/json", "x-intentic-connect": config.connectToken },
                rejectUnauthorized: !isLocalHost(url.hostname),
            },
            (response) => {
                let raw = "";
                response.on("data", (chunk: Buffer) => {
                    raw += chunk.toString();
                });
                response.on("end", () => {
                    let json: unknown;
                    try {
                        json = JSON.parse(raw);
                    } catch {
                        json = undefined;
                    }
                    resolve({ status: response.statusCode ?? 0, json });
                });
            },
        );
        req.on("error", reject);
        // Idle-socket timeout: a platform that accepts the connection but never answers must reject (and free the
        // relayed request) instead of hanging the caller, and the browser spinner behind it, forever.
        req.setTimeout(60_000, () => req.destroy(new Error("the platform did not respond in time")));
        req.end(payload);
    });
