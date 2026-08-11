/* THE HOST BRIDGE — the local posture's one outbound channel to whatever application embeds it.
 *
 * The app never knows WHICH host it is in: the host's own injected bootstrap (extension-owned code, not
 * ours) may define `window.intenticHost` with a `post` function, and everything the panels want the host to
 * do goes through it as a plain message. No host, no bridge — every send is a silent no-op, which is exactly
 * right for the dev server case where the "host" is a plain browser tab.
 *
 * The message vocabulary is deliberately tiny and grows only with a real surface behind it:
 *   - `intentic:open-file` { path, line? } — a file link activated; the HOST owns file viewing (an editor
 *     opens its own document, with its own diff and its own jump-to-line — re-rendering ours inside it would
 *     be a worse copy of what is already there).
 *   - `intentic:attention` { count } — how many agents are waiting on the person (a question, a permission,
 *     a review). The host renders it as its own affordance: a badge, a notification, a dock bounce. Sent on
 *     every change, including back to zero — the host clears with it. */

export interface HostMessage {
    readonly type: "intentic:open-file" | "intentic:attention";
    readonly [key: string]: unknown;
}

interface Host {
    readonly post: (message: HostMessage) => void;
}

const host = (): Host | undefined => {
    const candidate = (window as { intenticHost?: unknown }).intenticHost;
    if (typeof candidate === "object" && candidate !== null && typeof (candidate as Host).post === "function") {
        return candidate as Host;
    }
    return undefined;
};

export const hostPresent = (): boolean => host() !== undefined;

export const postToHost = (message: HostMessage): void => {
    try {
        host()?.post(message);
    } catch {
        // A broken bridge must never take a panel down — the message was advisory.
    }
};
