/* The directory-UI bridge allowlist, pure, no imports, so it's unit-testable without the sandbox/env stack. */

// What one verb sends: a contract procedure with exactly this input (the typed client encodes it into the route), or
// a GET of the one route the contract does not carry, its id encoded here.
export type BridgeCall =
    | { readonly procedure: "panels.list" }
    | { readonly procedure: "panels.start" | "panels.stop"; readonly input: { readonly repo: string } }
    | { readonly procedure: "workspace.file"; readonly input: { readonly path: string } }
    | { readonly path: string };

type ArgBag = Record<string, unknown>;

// A non-empty string arg or a hard failure: an empty id or path would name a malformed route.
const str = (args: ArgBag, key: string): string => {
    const value = args[key];
    if (typeof value !== `string` || value === ``) {
        throw new Error(`directory UI: "${key}" must be a non-empty string`);
    }
    return value;
};

// Keep this list tight, it is the entire surface a directory UI can touch. Panels are keyed by repository.
const VERBS: Readonly<Record<string, (args: ArgBag) => BridgeCall>> = {
    readFile: (a) => ({ procedure: `workspace.file`, input: { path: str(a, `path`) } }),
    listPanels: () => ({ procedure: `panels.list` }),
    startPanel: (a) => ({ procedure: `panels.start`, input: { repo: str(a, `repo`) } }),
    stopPanel: (a) => ({ procedure: `panels.stop`, input: { repo: str(a, `repo`) } }),
    panelTerminals: (a) => ({ path: `/panels/${encodeURIComponent(str(a, `repo`))}/terminals` }),
};

// Pure, no network. Resolve a bridge request to its single daemon call, or throw on an unknown verb / bad args.
export const resolveBridgeCall = (verb: string, args: ArgBag): BridgeCall => {
    // Own keys only: an inherited name (`constructor`) would hand the frame's own args back as the call.
    const build = Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined;
    if (build === undefined) {
        throw new Error(`directory UI: verb "${verb}" is not allowed`);
    }
    return build(args);
};
