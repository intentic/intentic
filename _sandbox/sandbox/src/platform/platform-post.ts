import { request } from "node:https";
import type { Config } from "../env.config.js";
import { isLocalHost } from "./local-tls.js";

/* THE DAEMON'S ONE OUTBOUND CHANNEL TO THE PLATFORM, shared by everything that speaks on it: the boot
 * registration (announce.ts) and the reachability report (reach-report.ts). Both authenticate the same way,
 * possession of the connect token, the same secret the daemon's own first-bind gate uses, and both must work
 * when the sandbox's TUNNEL does not, which is the entire reason they go out from in here rather than being
 * asked for from outside.
 *
 * node:https instead of fetch, for the one reason that forced it: undici can't skip TLS verification
 * per-request, and the process-global escape hatch would also disable it for Google/Anthropic/OpenAI calls. */

// What the platform said, or why nothing was said at all. Kept apart because the two mean opposite things to
// every caller: a status is the platform ANSWERING (and possibly refusing), while an error is the platform
// being out of reach from inside this container, one is a verdict, the other is a broken link.
export type PlatformPost = { readonly status: number } | { readonly error: string };

export const postToPlatform = async (config: Config, path: string, body: unknown): Promise<PlatformPost> => {
    // Built per call, not once: an unset PLATFORM_URL (a headless run, where nothing here is ever started)
    // must not throw while composing the daemon.
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
                response.resume(); // drain: nothing here reads a body, and an undrained socket leaks
                resolve({ status: response.statusCode ?? 0 });
            },
        );
        post.on("error", (error: unknown) => resolve({ error: error instanceof Error ? error.message : String(error) }));
        post.end(payload);
    });
};
