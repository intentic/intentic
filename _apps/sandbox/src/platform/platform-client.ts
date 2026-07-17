import { request } from "node:https";
import type { Config } from "../env.config.js";

// A single authenticated POST to the platform, authenticated by possession of the connect token (the announce
// pattern). node:https instead of fetch: undici can't skip TLS verification per-request, and a localhost dev
// platform arrives as a self-signed cert on host.docker.internal — the process-global escape hatch would also
// disable verification for Google/Anthropic/OpenAI. Everything else verifies normally.

// Hosts whose TLS is a local self-signed dev cert — mirrors announce.ts / connect.sh's `curl -k` gate.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "host.docker.internal"]);

export interface PlatformResponse {
    readonly status: number;
    readonly json: unknown;
}

// POST `body` (JSON) to `path` on the configured platform with the connect token. Rejects if no platform URL is
// configured (headless/loopback). Resolves with the status + parsed JSON body (undefined when unparseable) —
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
                rejectUnauthorized: !LOCAL_HOSTS.has(url.hostname),
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
        // relayed request) instead of hanging the caller — and the browser spinner behind it — forever.
        req.setTimeout(60_000, () => req.destroy(new Error("the platform did not respond in time")));
        req.end(payload);
    });
