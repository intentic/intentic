// Deliberately NOT `environment` from ./environment: that module throws when window.env is missing, which is
// the right contract for the app (env.js must load first) but the wrong one here — composables that read the
// posture also run under unit tests with no window at all, where the answer is simply "platform".

/* THE APP'S POSTURE — platform, or local.
 *
 * The platform posture is everything this app has always been: sign in with Google, find your sandboxes on
 * the platform's registry, establish a daemon session, drive the active sandbox over its tunnel.
 *
 * The LOCAL posture is the same app embedded by a host application (an editor extension, a CLI preview) over
 * an engine running in its local profile on this same machine: there is no platform, no account and no
 * session to establish — the person at the keyboard is the owner, exactly as the engine's own local floor
 * guarantees (it refuses to serve anything but loopback). The posture is declared by the HOST via
 * `window.env.local`, never derived: an app served from the hosted deployment can never drift into it.
 *
 * What reads this, and the whole of what the posture changes:
 *   - useSandbox seeds its list with the one synthetic entry instead of asking the platform
 *   - sandboxAuthFetch sends requests plain instead of establishing a daemon session
 *   - useEndpoint skips the loopback probe (the engine URL already is loopback)
 *   - the router serves the three local areas in memory history instead of the shell
 *   - App.vue mounts the session runtime unconditionally (there is no signed-out state)
 * Everything else — chat, the fleet board, accounts, liveness, streams — is the same code either way.
 */
export interface LocalPosture {
    // The local engine's origin, e.g. http://127.0.0.1:8787 — becomes the one sandbox's daemonUrl.
    readonly engineUrl: string;
    // Which of the three local areas this window opens on. A host with several panels sets one per panel.
    readonly view: "chat" | "agents" | "accounts";
    // What the one sandbox is called where a name is shown (the workspace folder's name, typically).
    readonly label: string;
}

const VIEWS = new Set(["chat", "agents", "accounts"]);

const read = (): LocalPosture | undefined => {
    const local = typeof window === "undefined" ? undefined : window.env?.local;
    if (local === undefined || local.engineUrl === "") {
        return undefined;
    }
    const view = local.view !== undefined && VIEWS.has(local.view) ? (local.view as LocalPosture["view"]) : "chat";
    return { engineUrl: local.engineUrl.replace(/\/+$/, ""), view, label: local.label !== undefined && local.label !== "" ? local.label : "This machine" };
};

// Snapshotted once at module eval, like `environment` itself — a posture cannot change mid-session.
const posture = read();

export const localPosture = (): LocalPosture | undefined => posture;
export const isLocalPosture = (): boolean => posture !== undefined;
