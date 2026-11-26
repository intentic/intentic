// The two reads this extension's backend answers (src/server/server.ts), named once for both halves. Each answer is a
// shape of the wire contract's `schemas/workspace/workspace-graph`, which the extension API versions, so a newer
// browser half reads an older backend's answer and the other way round.

// GET graph?repo=<id>: the repository's package graph (`WorkspaceGraph`).
export const GRAPH_ROUTE = `graph`;
// GET layers?repo=<id>&package=<name>: one package's units and the imports between them (`PackageModules`).
export const LAYERS_ROUTE = `layers`;

export const graphPath = (repo: string): string => `${GRAPH_ROUTE}?${new URLSearchParams({ repo }).toString()}`;
export const layersPath = (repo: string, name: string): string => `${LAYERS_ROUTE}?${new URLSearchParams({ repo, package: name }).toString()}`;

// A repository id as the workspace tree names it: one to four path segments, each starting with a letter or digit, so
// none is `..` and joining it under the workspace root never leaves it.
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;
const MAX_DEPTH = 4;
export const isRepoId = (repo: string): boolean => {
    const segments = repo.split(`/`);
    return segments.length <= MAX_DEPTH && segments.every((segment) => SEGMENT.test(segment));
};
