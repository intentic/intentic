import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Claim } from "./serve.js";

/**
 * A stand-in for PostHog at `/wire/*` (the path the app's analytics is proxied through, nginx.conf), so `--replay` runs
 * the app's real SDK and session recorder against this server: remote config that turns recording on, the recorder
 * script from the app's own installed posthog-js, and every capture accepted and dropped. What it costs the page to be
 * recorded is then measured, and nothing leaves the machine.
 */
export const wireClaim = (repo: string): Claim => {
    const require = createRequire(join(repo, "_editor", "web", "package.json"));
    const dist = join(dirname(require.resolve("posthog-js/package.json")), "dist");
    const config = {
        sessionRecording: { endpoint: "/s/", consoleLogRecordingEnabled: false, recordCanvas: false },
        supportedCompression: ["gzip-js"],
        autocaptureExceptions: false,
        heatmaps: false,
        surveys: false,
        capturePerformance: false,
        siteApps: [],
    };
    // Remote config; flags, which carry the same config; and a capture's acknowledgement.
    type Answer = typeof config | (typeof config & { readonly featureFlags: object; readonly featureFlagPayloads: object; readonly errorsWhileComputingFlags: boolean }) | { readonly status: number };
    return (request, response) => {
        const path = new URL(request.url ?? `/`, `http://x`).pathname;
        if (!path.startsWith(`/wire/`)) {
            return false;
        }
        const json = (body: Answer): void => {
            response.writeHead(200, { "content-type": `application/json` });
            response.end(JSON.stringify(body));
        };
        // The app prefixes every SDK file with `sdk.` (analytics.ts), which nginx strips; here it is simply read past.
        if (/recorder[^/]*\.js$/u.test(path)) {
            response.writeHead(200, { "content-type": `text/javascript` });
            response.end(readFileSync(join(dist, /lazy-recorder/u.test(path) ? `lazy-recorder.js` : `posthog-recorder.js`)));
            return true;
        }
        if (path.endsWith(`.js`)) {
            response.writeHead(200, { "content-type": `text/javascript` });
            response.end(``);
            return true;
        }
        if (/\/array\/[^/]+\/config$/u.test(path)) {
            json(config);
            return true;
        }
        if (/\/(?:flags|decide)\/?$/u.test(path)) {
            json({ featureFlags: {}, featureFlagPayloads: {}, errorsWhileComputingFlags: false, ...config });
            return true;
        }
        request.resume();
        request.once(`end`, () => json({ status: 1 }));
        return true;
    };
};
