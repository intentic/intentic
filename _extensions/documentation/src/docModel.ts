import type { FigureAccent } from "@intentic/extension-ui";

// Three layers: FACTS (computed by intentic-docs, never authored), JUDGEMENT (authored prose: READMEs and repo.md),
// PRESENTATION (owned by the app). Prose lives in markdown, not JSON, so structures here carry only what the app must
// read: identity, the map, anchors, provenance. Every parser is total; a malformed field costs itself, never the page.

// Provenance: the field that makes rot detectable.

// `sourceRev` is the documented directory's git revision at generation time, compared by `intentic-docs check`, not the
// browser, since a per-path history call would cost one request per commit.
export interface DocProvenance {
    readonly generatedAt: number;
    readonly sourceRev: string;
    // Which model wrote it; display only, but the first thing asked when a document reads oddly.
    readonly model?: string;
}

// repo.json: the map.

// A logical grouping of packages a reader thinks in, authored once by the map and shared by every package brief.
// `accent` is a stable, authored slot; assigning by position would repaint every component when one changes.
export interface DocComponent {
    readonly id: string;
    readonly name: string;
    readonly oneLiner: string;
    readonly packages: readonly string[];
    readonly accent?: FigureAccent;
}

// A term this repo uses in a way an outsider wouldn't guess; authored once by the map, inlined by every package brief.
export interface DocTerm {
    readonly term: string;
    readonly means: string;
}

export interface RepoDoc {
    readonly repo: string;
    readonly components: readonly DocComponent[];
    readonly glossary: readonly DocTerm[];
    // Package dirs in the order a newcomer should read them; ordered, a path not a set.
    readonly reading: readonly string[];
    readonly provenance: DocProvenance;
}

// A package's page: its README, read as data.

// A file worth opening, parsed from the README's `## Key files`, never authored as JSON. `intentic-docs validate`
// checks each still exists; a dead anchor is unarguable staleness that a commit count can't give you.
export interface DocAnchor {
    readonly path: string;
    readonly line?: number;
    readonly what: string;
}

// index.json: derived, never authored.

// A package's row in the generated index: everything about it besides its prose, all computed (one-liner, anchors,
// measures, staleness). `reason` says which check made `stale` true, since different causes call for different action.
export interface DocIndexEntry {
    readonly dir: string;
    // The package's own name (npm, cargo, ...) when it has one; a dir with no manifest has only its path.
    readonly name?: string;
    readonly oneLiner: string;
    readonly component?: string;
    readonly anchors: readonly DocAnchor[];
    // What the app draws its figures from, so no page has to hand-write a number that goes stale.
    readonly files: number;
    readonly loc: number;
    readonly hasTests: boolean;
    // Last commit that touched the README, and when it landed; the page's date, with no field to bump.
    readonly readmeRev: string;
    readonly updatedAt: number;
    readonly stale: boolean;
    readonly reason?: string;
    // Commits touching this dir since the README was last written. Zero and not stale is the healthy state.
    readonly behind: number;
}

// One intra-repo dependency, for the neighbour figure; `dev` marks a build/test-only edge, drawn weaker.
export interface DocEdge {
    readonly from: string;
    readonly to: string;
    readonly dev: boolean;
}

// The whole set's derived state. `orphans` are staged pages whose package is gone; a published page can't be orphaned,
// since it lives inside that directory.
export interface DocIndex {
    readonly repo: string;
    readonly generatedAt: number;
    readonly entries: readonly DocIndexEntry[];
    readonly edges: readonly DocEdge[];
    readonly orphans: readonly string[];
    // Package dirs with no README; shown as a number in the view, never as a rail badge, since it's lit every day.
    readonly undocumented: readonly string[];
}

// Total parsing.

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === `object` && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => {
    if (typeof value !== `string`) {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed === `` ? undefined : trimmed;
};

const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.flatMap((item) => (str(item) === undefined ? [] : [str(item) as string])) : [];

const num = (value: unknown): number | undefined => (typeof value === `number` && Number.isFinite(value) ? value : undefined);

const ACCENTS = new Set([`1`, `2`, `3`, `4`, `5`, `neutral`]);
const accentOf = (value: unknown): FigureAccent | undefined =>
    typeof value === `string` && ACCENTS.has(value) ? (value as FigureAccent) : undefined;

// Provenance is required; a document without it doesn't parse, since an optional date is a date that gets omitted.
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
    const rawEdges = body[`edges`];
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
            const rawAnchors = item[`anchors`];
            return [
                {
                    dir,
                    name: str(item[`name`]),
                    oneLiner: str(item[`oneLiner`]) ?? ``,
                    component: str(item[`component`]),
                    anchors: (Array.isArray(rawAnchors) ? rawAnchors : []).flatMap((entry) => {
                        const anchor = anchorOf(entry);
                        return anchor === undefined ? [] : [anchor];
                    }),
                    files: num(item[`files`]) ?? 0,
                    loc: num(item[`loc`]) ?? 0,
                    hasTests: item[`hasTests`] === true,
                    readmeRev: str(item[`readmeRev`]) ?? ``,
                    updatedAt: num(item[`updatedAt`]) ?? 0,
                    stale: item[`stale`] === true,
                    reason: str(item[`reason`]),
                    behind: num(item[`behind`]) ?? 0,
                },
            ];
        }),
        edges: (Array.isArray(rawEdges) ? rawEdges : []).flatMap((item): DocEdge[] => {
            if (!isRecord(item)) {
                return [];
            }
            const from = str(item[`from`]);
            const to = str(item[`to`]);
            return from === undefined || to === undefined ? [] : [{ from, to, dev: item[`dev`] === true }];
        }),
        orphans: strings(body[`orphans`]),
        undocumented: strings(body[`undocumented`]),
    };
};

// Inverts the map's authored component → packages relation into package → component, so the fact isn't stored twice.
export const componentOfPackage = (doc: RepoDoc, dir: string): DocComponent | undefined =>
    doc.components.find((component) => component.packages.includes(dir));
