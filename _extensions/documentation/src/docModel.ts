import type { FigureAccent } from "@intentic/extension-ui";

/* THE DOCUMENT MODEL — and, more importantly, the line between what a model authors and what a tool computes.
 *
 * Three layers produce a document set, and keeping them apart is the entire design:
 *
 *   FACTS      — the package graph, sizes, revisions, which dirs exist. Computed by `intentic-docs` (the bin
 *                tool this extension puts on the agent's PATH). Never authored, because a script gets them right
 *                for free and a model gets them plausibly wrong.
 *   JUDGEMENT  — what a component is FOR, which packages form one, what to read first, what is surprising.
 *                Authored, in `doc.md`/`repo.md` prose and the few fields below. This is the only part that
 *                needs a model, and the only part worth reviewing.
 *   PRESENTATION — theme, layout, dark mode, dagre, responsive, a11y. Owned by the app. Nothing here carries a
 *                colour, a coordinate or a size.
 *
 * WHY THE PROSE IS NOT IN HERE. The obvious alternative is a fat JSON document with `responsibilities: string[]`
 * and `flows: [{ steps }]`. It was rejected: it forces every explanation into one predeclared shape, splits a
 * narrative from the figures that belong inside it, and turns an unreadable JSON diff into the review surface.
 * So the DOCUMENT is markdown (with typed figure fences — see @intentic-app/ui/markdown's figures.ts), and these
 * structures carry only what the app must READ rather than render: identity, the map, anchors, provenance.
 *
 * Every parser here is total. A document set is written by a model into a repo the owner then reads; a field
 * that arrives malformed must cost that field, never the page. */

// ---- provenance: the one field that makes rot detectable ------------------------------------------------------

/* What the document was written against. `sourceRev` is the git revision of the DOCUMENTED DIRECTORY at
 * generation time, which is what makes "is this still true?" answerable at all: compare it to the dir's current
 * rev and the answer is a fact rather than a feeling.
 *
 * It is compared by the TOOL, not the browser. `GET /git/{repo}/log` takes only `{ repo, limit }` — no path
 * filter — so asking "what has touched this package since that rev" from the browser would cost one commit-diff
 * request per commit. `intentic-docs check` does it with one git call and writes the answer to index.json. */
export interface DocProvenance {
    readonly generatedAt: number;
    readonly sourceRev: string;
    // Which model wrote it. Display only, but it is the first thing anyone asks when a document reads oddly.
    readonly model?: string;
}

// ---- repo.json: the map --------------------------------------------------------------------------------------

/* A LOGICAL component — the grouping of packages a reader actually thinks in ("the control plane", "the wire"),
 * which is the highest-value and least verifiable thing in the whole set. It is authored by the map phase before
 * any package is documented, and every package brief is handed its own component and this glossary, so 42
 * independently written documents share one vocabulary instead of inventing 42.
 *
 * `accent` pins the component to one of the palette's five categorical slots. Authored, and stable: assigning by
 * position would repaint every other component the moment one is added or dropped. */
export interface DocComponent {
    readonly id: string;
    readonly name: string;
    readonly oneLiner: string;
    readonly packages: readonly string[];
    readonly accent?: FigureAccent;
}

// A term this repo uses in a way an outsider would not guess. The map authors it once; the package briefs inline
// it. Cheap, and it is most of what makes a set of documents read as one voice.
export interface DocTerm {
    readonly term: string;
    readonly means: string;
}

export interface RepoDoc {
    readonly repo: string;
    readonly components: readonly DocComponent[];
    readonly glossary: readonly DocTerm[];
    // Package dirs in the order a newcomer should read them. Ordered, so it is a reading path and not a set.
    readonly reading: readonly string[];
    readonly provenance: DocProvenance;
}

// ---- doc.json: one package -----------------------------------------------------------------------------------

/* A file worth opening, and why. Anchors are the cheapest lie-detector in the system: `intentic-docs validate`
 * checks that every one still exists, and an anchor pointing at a deleted file is an unarguable "this document
 * is out of date" that no revision comparison can give you (a doc can be stale in rev and still true, or current
 * in rev and describe a file that moved). They are also what the reader clicks. */
export interface DocAnchor {
    readonly path: string;
    readonly line?: number;
    readonly what: string;
}

export interface PackageDoc {
    // Repo-relative package dir — the identity, and the path the document set mirrors.
    readonly dir: string;
    // The package's own name (npm, cargo, …) when it has one; a dir with no manifest has only its path.
    readonly name?: string;
    /* ONE sentence, plain language. Owned here and nowhere else: the browser gets every package's one-liner from
     * the derived index.json, so this stays the single authored home and cannot drift from a copy. */
    readonly oneLiner: string;
    readonly keyFiles: readonly DocAnchor[];
    readonly provenance: DocProvenance;
}

// ---- index.json: derived, never authored ---------------------------------------------------------------------

/* One package's row in the generated index. `stale` is the tool's verdict, with `reason` saying which check
 * produced it — a reader who is told a document is stale immediately asks why, and "commits landed since" and
 * "it points at a file that is gone" call for different actions. */
export interface DocIndexEntry {
    readonly dir: string;
    readonly oneLiner: string;
    readonly component?: string;
    readonly sourceRev: string;
    readonly stale: boolean;
    readonly reason?: string;
    // Commits touching this dir since `sourceRev`. Zero and not stale is the healthy state.
    readonly behind: number;
}

/* The whole set's derived state. `orphans` are document directories whose package is GONE — the rot a revision
 * comparison structurally cannot see, because there is no source dir left to have a revision. */
export interface DocIndex {
    readonly repo: string;
    readonly generatedAt: number;
    readonly entries: readonly DocIndexEntry[];
    readonly orphans: readonly string[];
    // Package dirs with no document at all. Coverage belongs in the view as a number, never on the rail as a
    // badge — an undocumented count is lit every day, and a permanently lit badge teaches the eye to skip it.
    readonly undocumented: readonly string[];
}

// ---- total parsing -------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === `object` && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => {
    if (typeof value !== `string`) {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed === `` ? undefined : trimmed;
};

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap((item) => (str(item) === undefined ? [] : [str(item) as string])) : []);

const num = (value: unknown): number | undefined => (typeof value === `number` && Number.isFinite(value) ? value : undefined);

const ACCENTS = new Set([`1`, `2`, `3`, `4`, `5`, `neutral`]);
const accentOf = (value: unknown): FigureAccent | undefined =>
    typeof value === `string` && ACCENTS.has(value) ? (value as FigureAccent) : undefined;

/* Provenance is REQUIRED, and a document without it does not parse. That is deliberate: provenance is the only
 * thing standing between this system and a pile of prose nobody can date, and a document that is allowed to omit
 * it is a document that will. */
const provenanceOf = (value: unknown): DocProvenance | undefined => {
    if (!isRecord(value)) {
        return undefined;
    }
    const sourceRev = str(value[`sourceRev`]);
    const generatedAt = num(value[`generatedAt`]);
    if (sourceRev === undefined || generatedAt === undefined) {
        return undefined;
    }
    return { sourceRev, generatedAt, model: str(value[`model`]) };
};

const componentOf = (value: unknown): DocComponent | undefined => {
    if (!isRecord(value)) {
        return undefined;
    }
    const id = str(value[`id`]);
    const oneLiner = str(value[`oneLiner`]);
    if (id === undefined || oneLiner === undefined) {
        return undefined;
    }
    return { id, name: str(value[`name`]) ?? id, oneLiner, packages: strings(value[`packages`]), accent: accentOf(value[`accent`]) };
};

const anchorOf = (value: unknown): DocAnchor | undefined => {
    if (!isRecord(value)) {
        return undefined;
    }
    const path = str(value[`path`]);
    const what = str(value[`what`]);
    if (path === undefined || what === undefined) {
        return undefined;
    }
    const line = num(value[`line`]);
    // A line number of 0 is not a line; anchors are 1-indexed like every other path:line in this workspace.
    return { path, what, line: line !== undefined && line >= 1 ? Math.floor(line) : undefined };
};

const parsed = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

export const parseRepoDoc = (text: string): RepoDoc | undefined => {
    const body = parsed(text);
    if (!isRecord(body)) {
        return undefined;
    }
    const repo = body[`repo`];
    const provenance = provenanceOf(body[`provenance`]);
    // `repo` may legitimately be "" (the workspace's own root repo), so its presence is checked, not its truth.
    if (typeof repo !== `string` || provenance === undefined) {
        return undefined;
    }
    const rawComponents = body[`components`];
    const rawGlossary = body[`glossary`];
    return {
        repo,
        components: (Array.isArray(rawComponents) ? rawComponents : []).flatMap((item) => {
            const component = componentOf(item);
            return component === undefined ? [] : [component];
        }),
        glossary: (Array.isArray(rawGlossary) ? rawGlossary : []).flatMap((item): DocTerm[] => {
            if (!isRecord(item)) {
                return [];
            }
            const term = str(item[`term`]);
            const means = str(item[`means`]);
            return term === undefined || means === undefined ? [] : [{ term, means }];
        }),
        reading: strings(body[`reading`]),
        provenance,
    };
};

export const parsePackageDoc = (text: string): PackageDoc | undefined => {
    const body = parsed(text);
    if (!isRecord(body)) {
        return undefined;
    }
    const dir = str(body[`dir`]);
    const oneLiner = str(body[`oneLiner`]);
    const provenance = provenanceOf(body[`provenance`]);
    if (dir === undefined || oneLiner === undefined || provenance === undefined) {
        return undefined;
    }
    const rawKeyFiles = body[`keyFiles`];
    return {
        dir,
        name: str(body[`name`]),
        oneLiner,
        keyFiles: (Array.isArray(rawKeyFiles) ? rawKeyFiles : []).flatMap((item) => {
            const anchor = anchorOf(item);
            return anchor === undefined ? [] : [anchor];
        }),
        provenance,
    };
};

export const parseDocIndex = (text: string): DocIndex | undefined => {
    const body = parsed(text);
    if (!isRecord(body)) {
        return undefined;
    }
    const repo = body[`repo`];
    if (typeof repo !== `string`) {
        return undefined;
    }
    const rawEntries = body[`entries`];
    return {
        repo,
        generatedAt: num(body[`generatedAt`]) ?? 0,
        entries: (Array.isArray(rawEntries) ? rawEntries : []).flatMap((item): DocIndexEntry[] => {
            if (!isRecord(item)) {
                return [];
            }
            const dir = str(item[`dir`]);
            if (dir === undefined) {
                return [];
            }
            return [
                {
                    dir,
                    oneLiner: str(item[`oneLiner`]) ?? ``,
                    component: str(item[`component`]),
                    sourceRev: str(item[`sourceRev`]) ?? ``,
                    stale: item[`stale`] === true,
                    reason: str(item[`reason`]),
                    behind: num(item[`behind`]) ?? 0,
                },
            ];
        }),
        orphans: strings(body[`orphans`]),
        undocumented: strings(body[`undocumented`]),
    };
};

/* Which component a package belongs to, from the map's side of the relation. The map declares
 * component → packages (that is the direction a human authors it in); every reader wants package → component,
 * and deriving it here means the file never holds the same fact twice. */
export const componentOfPackage = (doc: RepoDoc, dir: string): DocComponent | undefined =>
    doc.components.find((component) => component.packages.includes(dir));
