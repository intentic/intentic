/* The directory-UI bridge allowlist, pure, no imports, so it's unit-testable without the sandbox/env stack.
 * This IS the security boundary: a directory UI (rendered in a sandboxed srcdoc iframe) may invoke only the
 * verbs here, each mapping its args to exactly one daemon call. Unknown verbs throw; ids are encoded into the
 * path so a crafted id can't escape its route. Adding a verb is a deliberate app change, a UI can't grant
 * itself more. The transport + postMessage wiring lives in useDirectoryUi.ts. */

export interface BridgeCall {
    readonly path: string;
    readonly method: "GET" | "POST" | "DELETE";
    readonly body?: string;
    // A streamed ndjson response (each line relayed as a `frame`) vs a single JSON body.
    readonly stream: boolean;
}

type ArgBag = Record<string, unknown>;

// A non-empty string arg or a hard failure, ids land in URL paths and must never be empty/injected.
const str = (args: ArgBag, key: string): string => {
    const value = args[key];
    if (typeof value !== `string` || value === ``) {
        throw new Error(`directory UI: "${key}" must be a non-empty string`);
    }
    return value;
};

// Keep this list tight, it is the entire surface a directory UI can touch. Panels are keyed by repository.
const VERBS: Readonly<Record<string, (args: ArgBag) => BridgeCall>> = {
    readFile: (a) => ({ path: `/workspace/file?path=${encodeURIComponent(str(a, `path`))}`, method: `GET`, stream: false }),
    listPanels: () => ({ path: `/panels`, method: `GET`, stream: false }),
    startPanel: (a) => ({ path: `/panels/${encodeURIComponent(str(a, `repo`))}/start`, method: `POST`, stream: false }),
    stopPanel: (a) => ({ path: `/panels/${encodeURIComponent(str(a, `repo`))}/stop`, method: `POST`, stream: false }),
    panelTerminals: (a) => ({ path: `/panels/${encodeURIComponent(str(a, `repo`))}/terminals`, method: `GET`, stream: false }),
};

// Pure, no network. Resolve a bridge request to its single daemon call, or throw on an unknown verb / bad args.
export const resolveBridgeCall = (verb: string, args: ArgBag): BridgeCall => {
    const build = VERBS[verb];
    if (build === undefined) {
        throw new Error(`directory UI: verb "${verb}" is not allowed`);
    }
    return build(args);
};
