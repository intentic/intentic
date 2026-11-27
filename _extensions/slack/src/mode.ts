// WHICH WAY SLACK REACHES A CARD'S APP (2026-11-27): Socket Mode's outbound WebSocket, which needs no public URL but is
// heard only while the sandbox runs, or HTTP mode, Slack POSTing to the app's Request URL (http.ts), which a sandbox the
// platform hosts needs: it sleeps when nobody uses it, and a request at its wake URL wakes it. Kept apart from the Slack
// SDK so the backend (server.ts) can ask without loading it.

export type SlackMode = "socket" | "http";

// What a card holds that says how Slack reaches its app.
export interface SlackInboundConfig {
    // The app-level token (xapp-, connections:write) Socket Mode opens its WebSocket with.
    readonly appToken?: string | undefined;
    // The app's signing secret, which vouches for a call to its Request URL.
    readonly signingSecret?: string | undefined;
}

/** Whether this sandbox is one the platform hosts (a machine that sleeps when nobody uses it), as the daemon reads it. */
export const isHostedSandbox = (env: NodeJS.ProcessEnv = process.env): boolean => env["SANDBOX_VM"] === "1";

/**
 * How Slack reaches a card's app. A sandbox the platform hosts takes Request URLs once the card holds the app's signing
 * secret, and keeps Socket Mode until then, so an app set up before HTTP mode keeps answering while the sandbox is
 * awake; any other sandbox keeps Socket Mode while the card holds an app-level token. Undefined: the card holds neither.
 */
export const slackModeOf = (config: SlackInboundConfig, hosted: boolean): SlackMode | undefined => {
    const socket = (config.appToken ?? "") !== "";
    const http = (config.signingSecret ?? "") !== "";
    if (hosted) {
        return http ? "http" : socket ? "socket" : undefined;
    }
    return socket ? "socket" : http ? "http" : undefined;
};
