import { request } from "node:https";
import { errorMessage } from "@intentic/base/errors";
import type { Config } from "../env.config.js";
import { isLocalHost } from "./tls/local-tls.js";

// The daemon's one outbound channel to the platform, shared by boot registration (announce.ts) and the reachability
// report (reach-report.ts), both authenticated by the connect token. node:https, not fetch: undici can't skip TLS
// verification per-request without disabling it for every provider call too.

// A status is the platform answering (a verdict); an error means it was unreachable from inside this container (a
// broken link).
export type PlatformPost = { readonly status: number } | { readonly error: string };

export const postToPlatform = async (config: Config, path: string, body: unknown): Promise<PlatformPost> => {
    // Built per call: an unset PLATFORM_URL (headless) must not throw while composing the daemon.
    const url = new URL(path, config.platform.url);
    const payload = JSON.stringify(body);
    return new Promise<PlatformPost>((resolve) => {
        const post = request(
            url,
            {
                method: "POST",
                headers: { "content-type": "application/json", "x-intentic-connect": config.connectToken },
                rejectUnauthorized: !isLocalHost(url.hostname),
            },
            (response) => {
                response.resume(); // drain: nothing reads the body, and an undrained socket leaks
                resolve({ status: response.statusCode ?? 0 });
            },
        );
        post.on("error", (error: unknown) => resolve({ error: errorMessage(error) }));
        post.end(payload);
    });
};
