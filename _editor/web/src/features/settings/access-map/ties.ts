import { type AccountGraph, type GraphEdge, YOU_ID } from "./accountGraph";

// ONE THING'S TIES, IN THE ORDER A READER ASKS ABOUT THEM: for a sandbox, what its agents reach out to, then who reaches
// in, then where it runs; for a computer or a server, which sandboxes reach it, then which run on it; for the account,
// the sandboxes it is in. The words are the view's (accessMapWords.ts); this only says which tie is which.

export type TieVerb = `in` | `handsTo` | `reaches` | `signsIn` | `takesFrom` | `runsOn` | `reachedFrom` | `signedInFrom` | `hosts`;

export interface Tie {
    readonly verb: TieVerb;
    readonly edge: GraphEdge;
    /** The node at the tie's other end. */
    readonly other: string;
}

const ORDER: readonly TieVerb[] = [`in`, `handsTo`, `reaches`, `signsIn`, `takesFrom`, `runsOn`, `reachedFrom`, `signedInFrom`, `hosts`];

const outward = (edge: GraphEdge): TieVerb | undefined => {
    switch (edge.kind) {
        case `member`:
            return `in`;
        case `link`:
            return `handsTo`;
        case `device`:
            return `reaches`;
        case `server`:
            return `signsIn`;
        case `runs`:
            return `runsOn`;
        default:
            return undefined;
    }
};

const inward = (edge: GraphEdge): TieVerb | undefined => {
    switch (edge.kind) {
        case `link`:
            return `takesFrom`;
        case `device`:
            return `reachedFrom`;
        case `server`:
            return `signedInFrom`;
        case `runs`:
            return `hosts`;
        default:
            // The account's way into a sandbox is said on the account, not as something reaching the sandbox.
            return undefined;
    }
};

export const tiesOf = (graph: AccountGraph, id: string): Tie[] => {
    const ties: Tie[] = [];
    for (const edge of graph.edges) {
        const out = edge.from === id ? outward(edge) : undefined;
        const into = edge.to === id && id !== YOU_ID ? inward(edge) : undefined;
        if (out !== undefined) {
            ties.push({ verb: out, edge, other: edge.to });
        }
        if (into !== undefined) {
            ties.push({ verb: into, edge, other: edge.from });
        }
    }
    return ties.sort((a, b) => ORDER.indexOf(a.verb) - ORDER.indexOf(b.verb));
};
