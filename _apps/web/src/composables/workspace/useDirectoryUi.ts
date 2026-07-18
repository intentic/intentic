import type { BridgeCall } from "./directoryUiVerbs";
import { resolveBridgeCall } from "./directoryUiVerbs";
import { readIntenticLines } from "../intenticStream";
import { sandboxJson, sandboxRequest } from "../sandbox/sandboxClient";
import { errorMessage } from "../useAsyncAction";

/* Directory-defined UI: a workspace directory ships its own interaction surface as a single self-contained
 * `<dir>/.intentic/ui/index.html` (inline JS/CSS). The parent reads that file through the SAME authed daemon
 * file route the tree uses, then renders it into a `<iframe sandbox="allow-scripts" srcdoc>` — an opaque origin
 * that can't read the parent DOM, cookies, or the Google/TOFU tokens sandboxClient holds.
 *
 * The UI talks to its sandbox ONLY through this postMessage bridge, which proxies the narrow allowlist in
 * directoryUiVerbs.ts. The parent runs the real call via sandboxClient — injecting auth on its side — so raw
 * tokens never cross the frame boundary, and anything off the allowlist is rejected.
 *
 * Wire protocol (iframe → parent):  { __intentic: true, id, verb, args }
 * Reply (parent → iframe):
 *   non-stream: { __intentic: true, id, ok: true, data } | { __intentic: true, id, ok: false, error }
 *   stream:     { __intentic: true, id, frame } … repeated, then { __intentic: true, id, done: true }
 *               (an error mid-stream arrives as { id, ok: false, error }). */

// Read a directory's UI document, or undefined when it declares none (the daemon 404s the missing file). dir is
// root-relative ("" = /work root); the escape hatch when there's no UI is the normal file tree.
export const loadDirectoryUi = async (dir: string): Promise<string | undefined> => {
    const path = dir === `` ? `.intentic/ui/index.html` : `${dir}/.intentic/ui/index.html`;
    try {
        const body = await sandboxJson<{ content: string }>(`/workspace/file?path=${encodeURIComponent(path)}`);
        return body.content;
    } catch {
        return undefined;
    }
};

const init = (call: BridgeCall): RequestInit => ({
    method: call.method,
    ...(call.body !== undefined ? { headers: { "content-type": `application/json` }, body: call.body } : {}),
});

// Attach the bridge to a rendered iframe; returns a teardown. Messages are validated by SOURCE (event.source ===
// the frame's window), not origin — a srcdoc/sandbox frame is an opaque "null" origin, so the origin string is
// untrustworthy. Replies go straight to that frame's window, so targetOrigin "*" reaches only it (and carries no
// secrets — just app/script output).
export const createDirectoryUiBridge = (iframe: HTMLIFrameElement): (() => void) => {
    const onMessage = async (event: MessageEvent): Promise<void> => {
        const frame = iframe.contentWindow;
        if (frame === null || event.source !== frame) {
            return;
        }
        const msg = event.data as { __intentic?: unknown; id?: unknown; verb?: unknown; args?: unknown };
        if (msg?.__intentic !== true || typeof msg.id !== `string` || typeof msg.verb !== `string`) {
            return;
        }
        const id = msg.id;
        const reply = (payload: Record<string, unknown>): void => frame.postMessage({ __intentic: true, id, ...payload }, `*`);
        try {
            const call = resolveBridgeCall(msg.verb, (msg.args as Record<string, unknown> | undefined) ?? {});
            if (!call.stream) {
                reply({ ok: true, data: await sandboxJson(call.path, init(call)) });
                return;
            }
            const response = await sandboxRequest(call.path, init(call));
            if (!response.ok || response.body === null) {
                throw new Error(`Request failed (${response.status}).`);
            }
            for await (const frameLine of readIntenticLines(response.body)) {
                reply({ frame: frameLine });
            }
            reply({ done: true });
        } catch (error) {
            reply({ ok: false, error: errorMessage(error, `directory UI call failed`) });
        }
    };
    window.addEventListener(`message`, onMessage);
    return () => window.removeEventListener(`message`, onMessage);
};
