import { STATE_DIR } from "@intentic/constants";
import { errorMessage } from "@intentic/ui/async";
import { type BridgeCall, resolveBridgeCall } from "./directoryUiVerbs";
import { readFileWindow } from "../files/fileWindow";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";

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

// Sends one allowed call: its procedure on the typed client, or the GET the contract does not carry on the raw one.
const send = (call: BridgeCall): Promise<unknown> => {
    if (`path` in call) {
        return sandboxJson(call.path);
    }
    switch (call.procedure) {
        case `panels.list`:
            return sandboxRpc.panels.list();
        case `panels.start`:
            return sandboxRpc.panels.start(call.input);
        case `panels.stop`:
            return sandboxRpc.panels.stop(call.input);
        case `workspace.file`:
            return sandboxRpc.workspace.file(call.input);
    }
};

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
            reply({ ok: true, data: await send(call) });
        } catch (error) {
            reply({ ok: false, error: errorMessage(error, `directory UI call failed`) });
        }
    };
    window.addEventListener(`message`, onMessage);
    return () => window.removeEventListener(`message`, onMessage);
};
