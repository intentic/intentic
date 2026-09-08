import { STATE_DIR } from "@intentic/constants";
import { errorMessage } from "@intentic/ui/async";
import type { BridgeCall } from "./directoryUiVerbs";
import { resolveBridgeCall } from "./directoryUiVerbs";
import { readFileWindow } from "../files/fileWindow";
import { readIntenticLines } from "../../../lib/intenticStream";
import { sandboxJson, sandboxRequest } from "../../sandbox/client/sandboxClient";

// Directory-defined UI: a directory's self-contained `.intentic/ui/index.html`, read via the normal file route
// and rendered into a sandboxed, opaque-origin iframe with no DOM/cookie/token access. Talks to its sandbox only
// via postMessage, proxied through directoryUiVerbs.ts's allowlist so raw auth never crosses the frame.

// Reads a directory's UI doc, or undefined when it declares none (dir is root-relative, "" = /work root).
// Most directories declare none, so absence is a normal answer, not a failure — this is the tree's most-asked check.
export const loadDirectoryUi = async (dir: string): Promise<string | undefined> => {
    const path = dir === `` ? `${STATE_DIR}/ui/index.html` : `${dir}/.intentic/ui/index.html`;
    try {
        const window = await readFileWindow(path);
        return window.present ? window.content : undefined;
    } catch {
        return undefined;
    }
};

const init = (call: BridgeCall): RequestInit => ({
    method: call.method,
    ...(call.body !== undefined ? { headers: { "content-type": `application/json` }, body: call.body } : {}),
});

// Validates messages by source (the iframe's own window), not origin — a sandboxed srcdoc frame's origin is
// opaque "null". Replies target that window directly, so targetOrigin "*" is safe: it carries no secrets.
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
