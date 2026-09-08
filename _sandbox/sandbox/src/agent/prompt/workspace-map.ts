import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { IGNORED_DIRS, isPublicPath, isReferencePath } from "@intentic/workspace-ignore";

// Which areas a project has, what each is for, and where the run stands; recomputed from the filesystem every
// conversation instead of stored, so it can't drift the way a written paragraph would. Areas, not files, since sessions
// share almost no files but nearly all work lands in a handful of top-level areas. Rides the user message, not the
// system prefix, since it's computed per conversation.

export const WORKSPACE_MAP_NOTE_HEADER = "## Map of this project";
// The chat-row title paired with WORKSPACE_MAP_NOTE_HEADER (turn-preamble.ts).
export const WORKSPACE_MAP_NOTE_TITLE = "Map of this project";

// Hard ceiling in characters (~4/token); detail sheds to hold it — purpose lines first, then whole areas, never a
// mid-structure truncation.
const MAX_NOTE_CHARS = 2_800;

// A purpose line longer than this is a paragraph, not a label. Cut at a word boundary.
const MAX_PURPOSE_CHARS = 100;

// Walk bounds matching modules.ts/repo-discovery.ts: a pathological tree stops the scan rather than stalling the turn.
// Depth 4 is enough for a meaningful file count without descending into a vendored checkout.
const MAX_AREA_DEPTH = 4;
const MAX_AREA_ENTRIES = 4_000;
// Past this many areas a listing stops being a map. The biggest by file count win; the rest are counted.
const MAX_AREAS = 24;
// How many child directories with manifests make a directory a CONTAINER of areas rather than an area itself.
const CONTAINER_MIN_CHILDREN = 3;
// Share of a project's files an area needs to be opened up for a run standing nowhere in particular: a majority, since
// picking the largest of several peers would be picking a favourite.
const DOMINANT_SHARE = 0.5;
// Children one opened area may list; capped since the note has a whole-note budget and a huge area could otherwise push
// its own opening past it, dropping it entirely. Extras past this are counted, not dropped.
const MAX_EXPANDED = 12;

// Manifests in the order they're believed; a directory carrying more than one is described by the first that actually
// says something.
const MANIFESTS = ["package.json", "pyproject.toml", "Cargo.toml", "composer.json", "go.mod", "build.gradle", "pom.xml"] as const;

export interface MapArea {
    // The area's path relative to the project root, a real path, so it can be used rather than only read.
    readonly name: string;
    readonly files: number;
    // The two commonest file extensions, without dots, a language hint that needs no language table.
    readonly kinds: readonly string[];
    // What the directory's own files say it is for. Empty when they say nothing; never invented.
    readonly purpose: string;
    // The run starts inside this area.
    readonly here: boolean;
    // Packages this area holds if it's a shelf; always known (falls out of deciding shelf-or-not) and always shown,
    // even when not worth expanding.
    readonly packages: number;
    // Filled for at most one area: the one the run stands in, or (standing nowhere) the one holding most of the
    // project. Expanding every container at once buries the areas that matter under the packages nobody asked about.
    readonly children: readonly MapArea[];
    // Children this area has but doesn't list; said out loud (areaBlock), since a list that silently stops reads as
    // complete.
    readonly childrenOmitted: number;
}

export interface WorkspaceMap {
    // Root-relative path of the project the map describes ("" when the workspace root IS the project).
    readonly project: string;
    // Root-relative path of the folder the run starts in.
    readonly cwd: string;
    readonly areas: readonly MapArea[];
    // Areas that existed but did not fit the budget.
    readonly omitted: number;
    // Other top-level entries of the workspace, named only. Empty for a single-project workspace.
    readonly siblings: readonly string[];
}

const posix = (path: string): string => path.split(sep).join("/");

// A directory this workspace's conventions don't gray out. `relPath` is root-relative so refs/ and public/ are
// recognised only at the top level; a project's own `public/` stays ordinary content.
const isBrowsable = (name: string, relPath: string): boolean =>
    !name.startsWith(".") && !IGNORED_DIRS.has(name) && !isReferencePath(relPath) && !isPublicPath(relPath);

const childDirs = (dir: string, root: string): string[] => {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        // Unreadable (permissions, a symlink that went nowhere). It contributes nothing; the rest still does.
        return [];
    }
    return entries
        .filter((entry) => entry.isDirectory() && isBrowsable(entry.name, posix(relative(root, join(dir, entry.name)))))
        .map((entry) => entry.name)
        .toSorted();
};

const readIfPresent = (path: string): string | undefined => {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return undefined;
    }
};

const hasManifest = (dir: string): boolean => MANIFESTS.some((name) => readIfPresent(join(dir, name)) !== undefined);

// From the directory's own files only. Order is believability: a manifest's description was written to describe the
// package, a README's opening line only usually does. Empty beats a guess.
const describeManifest = (dir: string, name: string): string | undefined => {
    const source = readIfPresent(join(dir, name));
    if (source === undefined) {
        return undefined;
    }
    if (name.endsWith(".json")) {
        try {
            const description = (JSON.parse(source) as { description?: unknown }).description;
            return typeof description === "string" && description.trim() !== "" ? description.trim() : undefined;
        } catch {
            return undefined;
        }
    }
    if (name === "go.mod") {
        // The module path's tail is the only non-boilerplate part of a go.mod's self-description.
        const module = /^\s*module\s+(\S+)/m.exec(source)?.[1];
        return module === undefined ? undefined : `Go module ${module.split("/").slice(-2).join("/")}`;
    }
    // TOML (pyproject, Cargo) and the JVM manifests: one `description = "…"` / `<description>…</description>`.
    const toml = /^\s*description\s*=\s*["'](.+?)["']\s*$/m.exec(source)?.[1];
    const xml = /<description>([^<]+)<\/description>/.exec(source)?.[1];
    const found = (toml ?? xml)?.trim();
    return found === undefined || found === "" ? undefined : found;
};

// A README's first line of actual prose: title, badges, banners, quotes, front matter and list items are stepped over
// rather than pattern-matched away one by one.
const describeReadme = (dir: string): string | undefined => {
    const source = readIfPresent(join(dir, "README.md")) ?? readIfPresent(join(dir, "readme.md"));
    if (source === undefined) {
        return undefined;
    }
    // Front matter, if any, is metadata about the document rather than the document.
    const body = source.replace(/^---[\s\S]*?\n---\s*/, "");
    for (const raw of body.split("\n")) {
        const line = raw.trim();
        if (line === "" || line.startsWith("#") || line.startsWith("<") || line.startsWith(">") || line.startsWith("|")) {
            continue;
        }
        // A badge row is link-and-image soup with no prose left once it is stripped.
        const prose = line
            .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
            .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
            .replace(/[*_`]/g, "")
            .trim();
        if (prose === "" || prose.startsWith("-") || prose.startsWith("*")) {
            continue;
        }
        return prose;
    }
    return undefined;
};

const clip = (text: string, max: number): string => {
    const oneLine = text.replace(/\s+/g, " ").trim();
    if (oneLine.length <= max) {
        return oneLine;
    }
    const head = oneLine.slice(0, max);
    const lastSpace = head.lastIndexOf(" ");
    return `${(lastSpace > max / 2 ? head.slice(0, lastSpace) : head).replace(/[.,;:]$/, "")}…`;
};

const purposeOf = (dir: string): string => {
    for (const name of MANIFESTS) {
        const described = describeManifest(dir, name);
        if (described !== undefined) {
            return clip(described, MAX_PURPOSE_CHARS);
        }
    }
    const readme = describeReadme(dir);
    return readme === undefined ? "" : clip(readme, MAX_PURPOSE_CHARS);
};

// File count and top extensions from one bounded walk. The count is a SIGNAL, not an inventory, good enough to tell a
// core area from a scratch folder without being exact.
const measure = (dir: string, root: string): { files: number; kinds: string[] } => {
    const extensions = new Map<string, number>();
    let files = 0;
    let visited = 0;
    const walk = (current: string, depth: number): void => {
        if (depth > MAX_AREA_DEPTH || visited >= MAX_AREA_ENTRIES) {
            return;
        }
        let entries;
        try {
            entries = readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (visited >= MAX_AREA_ENTRIES) {
                return;
            }
            visited += 1;
            const child = join(current, entry.name);
            if (entry.isDirectory()) {
                if (isBrowsable(entry.name, posix(relative(root, child)))) {
                    walk(child, depth + 1);
                }
                continue;
            }
            if (!entry.isFile() || entry.name.startsWith(".")) {
                continue;
            }
            files += 1;
            const dot = entry.name.lastIndexOf(".");
            if (dot > 0) {
                const ext = entry.name.slice(dot + 1).toLowerCase();
                // A long "extension" is a filename with dots in it, not a kind of file.
                if (ext.length <= 5) {
                    extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
                }
            }
        }
    };
    walk(dir, 0);
    const kinds = [...extensions.entries()]
        .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 2)
        .map(([ext]) => ext);
    return { files, kinds };
};

// Nearest git boundary at or above the starting folder, floored at the workspace root: the run's actual project, not
// the workspace top. No git anywhere still gets a map — a directory of code is a project either way.
const projectRootOf = (root: string, cwd: string): string => {
    let current = cwd;
    for (;;) {
        try {
            // `.git` may be a directory or a pointer file (worktree, submodule); either counts as a boundary.
            statSync(join(current, ".git"));
            return current;
        } catch {
            // No boundary here, keep climbing.
        }
        if (current === root || current === dirname(current)) {
            return root;
        }
        const parent = dirname(current);
        // A cwd outside the root stops at the root instead of climbing out of the workspace.
        if (relative(root, parent).startsWith("..")) {
            return root;
        }
        current = parent;
    }
};

interface AreaDir {
    readonly name: string;
    readonly dir: string;
    // The packages inside it, when it is a container of packages. Empty otherwise.
    readonly packages: readonly { readonly name: string; readonly dir: string }[];
}

// Is this a shelf (packages/, apps/, crates/, …) rather than an area? Judged by shape, not name: a directory of
// manifest-bearing children that is not itself a package, in any ecosystem.
const packagesIn = (dir: string, root: string): { name: string; dir: string }[] => {
    if (hasManifest(dir)) {
        return [];
    }
    const children = childDirs(dir, root);
    const bearing = children.filter((child) => hasManifest(join(dir, child)));
    return children.length >= CONTAINER_MIN_CHILDREN && bearing.length >= CONTAINER_MIN_CHILDREN
        ? bearing.map((child) => ({ name: child, dir: join(dir, child) }))
        : [];
};

// A project's own top-level directories, except when the root itself is just a shelf (one or two entries, one of them a
// container): then its packages are promoted to areas instead. A shelf among real areas stays one line until the run is
// inside it.
const areaDirsOf = (projectRoot: string, root: string): AreaDir[] => {
    const names = childDirs(projectRoot, root);
    const areas = names.map((name) => {
        const dir = join(projectRoot, name);
        return { name, dir, packages: packagesIn(dir, root) };
    });
    const shelf = areas.length <= 2 ? areas.find((area) => area.packages.length > 0) : undefined;
    return shelf === undefined ? areas : shelf.packages.map((entry) => ({ name: `${shelf.name}/${entry.name}`, dir: entry.dir, packages: [] }));
};

export interface WorkspaceMapInput {
    // The workspace root, for the sibling line and as the floor of the climb.
    readonly root: string;
    // Where this run actually starts, a persona's start folder, an isolated worktree, or the root.
    readonly cwd: string;
}

// The map, or undefined when there's nothing worth saying: a project with one area or none fits in a single listing
// already.
export const workspaceMapOf = ({ root, cwd }: WorkspaceMapInput): WorkspaceMap | undefined => {
    const projectRoot = projectRootOf(root, cwd);
    const found = areaDirsOf(projectRoot, root);
    if (found.length < 2) {
        return undefined;
    }
    const cwdRel = posix(relative(projectRoot, cwd));
    // "In" an area means the cwd is that area or a path under it; a cwd at the project root is in none.
    const isHere = (name: string): boolean => cwdRel === name || cwdRel.startsWith(`${name}/`);
    // A package inside a shelf is never itself expanded: one level of zoom is the point.
    const asArea = (name: string, dir: string, packages: number, children: readonly MapArea[]): MapArea => {
        const { files, kinds } = measure(dir, root);
        return { name, files, kinds, purpose: purposeOf(dir), here: isHere(name), packages, children, childrenOmitted: 0 };
    };
    // One area's children, measured and ranked like the top level. Lazy on purpose: walking every package of every
    // shelf just to print an unread number is exactly what this note argues against.
    const expand = (parent: string, entries: readonly { readonly name: string; readonly dir: string }[]): Pick<MapArea, "children" | "childrenOmitted"> => {
        const ranked = entries
            .map((entry) => asArea(`${parent}/${entry.name}`, entry.dir, packagesIn(entry.dir, root).length, []))
            .toSorted((left, right) => right.files - left.files || left.name.localeCompare(right.name));
        return { children: ranked.slice(0, MAX_EXPANDED), childrenOmitted: Math.max(0, ranked.length - MAX_EXPANDED) };
    };
    const base = found.map((area) => ({ ...area, measured: asArea(area.name, area.dir, area.packages.length, []) }));
    // Two ways an area gets opened: the one the run stands in, or — standing nowhere, which turned out to be nearly
    // every run — the one holding a MAJORITY of the project's files, not merely the largest, since a near-tie shouldn't
    // pick a favourite. Recurses one level via areaDirsOf, since a dominant area is routinely its own project, not a
    // shelf of packages.
    const total = base.reduce((sum, entry) => sum + entry.measured.files, 0);
    const biggest = base.toSorted((left, right) => right.measured.files - left.measured.files)[0];
    const dominant = cwdRel === "" && biggest !== undefined && biggest.measured.files >= total * DOMINANT_SHARE ? biggest.name : undefined;
    const measured = base.map(({ name, dir, packages, measured: area }): MapArea => {
        if (isHere(name)) {
            return { ...area, ...expand(name, packages) };
        }
        return name === dominant ? { ...area, ...expand(name, areaDirsOf(dir, root)) } : area;
    });
    // Biggest first: with a budget to hold, the areas most of the work is in are the ones worth the characters.
    const ranked = measured.toSorted((left, right) => right.files - left.files || left.name.localeCompare(right.name));
    const kept = ranked.slice(0, MAX_AREAS);
    // An area the run is standing in is never dropped for being small.
    const here = ranked.slice(MAX_AREAS).filter((area) => area.here);
    const areas = [...kept, ...here];
    return {
        project: posix(relative(root, projectRoot)),
        cwd: posix(relative(root, cwd)),
        areas,
        omitted: ranked.length - areas.length,
        // Only meaningful when the project isn't the whole workspace: names what else is there, nothing more.
        siblings: projectRoot === root ? [] : childDirs(root, root).filter((name) => name !== basename(projectRoot)),
    };
};

const sizeOf = (area: MapArea): string =>
    `${area.files} file${area.files === 1 ? "" : "s"}${area.kinds.length > 0 ? ` · ${area.kinds.join(", ")}` : ""}${area.packages > 0 ? ` · ${area.packages} packages` : ""}`;

const areaLine = (area: MapArea, width: number, indent: string): string =>
    `${indent}${area.name.padEnd(width - indent.length)}  ${sizeOf(area)}${area.here && area.children.length === 0 ? "  ← you are here" : ""}`;

// Every line an area contributes: itself, its purpose if budget allows, and its children if expanded.
const areaBlock = (area: MapArea, width: number, silent: ReadonlySet<string>): string[] => [
    areaLine(area, width, "  "),
    ...(area.purpose === "" || silent.has(area.name) ? [] : [`  ${" ".repeat(width - 2)}  ${area.purpose}`]),
    ...area.children.flatMap((child) => [
        areaLine(child, width, "      "),
        ...(child.purpose === "" || silent.has(child.name) ? [] : [`      ${" ".repeat(width - 6)}  ${child.purpose}`]),
    ]),
    // What opening this area left out; unsaid, it reads as if that were the whole list.
    ...(area.childrenOmitted > 0 ? [`      … and ${area.childrenOmitted} more in ${area.name}`] : []),
];

// Rendered to fit: purpose lines of the smallest areas shed first (a name and size still locate one), then whole small
// areas; what's dropped is always counted, never silent.
const render = (map: WorkspaceMap): string => {
    const project = map.project === "" ? "the workspace" : `\`${map.project}\``;
    const all = map.areas.flatMap((area) => [area, ...area.children]);
    // Size column starts past the longest name at its own indent; an expanded package's extra 4-space indent counts
    // too, or its columns hang off the rest.
    const width = Math.min(
        Math.max(...map.areas.flatMap((area) => [area.name.length + 2, ...area.children.map((child) => child.name.length + 6)])) + 2,
        34,
    );
    const head = [
        WORKSPACE_MAP_NOTE_HEADER,
        "",
        "This is current filesystem context. It maps project areas, not file locations; use `iq files` or Read for exact paths.",
        "Do not `ls` or `tree` the workspace root to orient yourself — the map above is that orientation.",
        "",
        map.cwd === map.project ? `You are at the top of ${project}.` : `You are here: \`${map.cwd}\``,
        "",
        `${project}, ${map.areas.length} area${map.areas.length === 1 ? "" : "s"}${map.omitted > 0 ? `, plus ${map.omitted} smaller ones not listed` : ""}`,
    ];
    const tail = map.siblings.length > 0 ? ["", `Also under the workspace root: ${map.siblings.map((name) => `${name}/`).join(", ")}`] : [];
    // Purposes are dropped from the smallest areas up, so the shed always costs the least-consulted line first.
    const byFilesAsc = all.toSorted((left, right) => left.files - right.files).map((area) => area.name);
    for (let muted = 0; muted <= byFilesAsc.length; muted += 1) {
        const silent = new Set(byFilesAsc.slice(0, muted));
        const note = [...head, ...map.areas.flatMap((area) => areaBlock(area, width, silent)), ...tail].join("\n");
        if (note.length <= MAX_NOTE_CHARS) {
            return note;
        }
    }
    // Purposes are already gone and names alone still overflow: keep the head, keep what fits, count the rest.
    const silent = new Set(byFilesAsc);
    const lines: string[] = [];
    let used = [...head, ...tail].join("\n").length;
    let dropped = 0;
    for (const area of map.areas) {
        const block = areaBlock(area, width, silent);
        const cost = block.reduce((sum, line) => sum + line.length + 1, 0);
        if (used + cost > MAX_NOTE_CHARS) {
            dropped += 1;
            continue;
        }
        used += cost;
        lines.push(...block);
    }
    const total = map.omitted + dropped;
    return [...head, ...lines, ...(total > 0 ? [`  … and ${total} more`] : []), ...tail].join("\n");
};

// Cached per project directory to collapse a burst of conversations opening together. Short TTL, not
// watcher-invalidated, on purpose: the whole value of this note is that it can't go stale, and a minute is well inside
// that window.
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; note: string | undefined }>();

// Swallows its own failures: this is unsolicited help, so an unreadable directory or a filesystem that moved mid-walk
// should cost the note, never the turn.
export const workspaceMapNote = (input: WorkspaceMapInput): string | undefined => {
    const key = `${input.root}\u0000${input.cwd}`;
    const hit = cache.get(key);
    if (hit !== undefined && Date.now() - hit.at < TTL_MS) {
        return hit.note;
    }
    let note: string | undefined;
    try {
        const map = workspaceMapOf(input);
        note = map === undefined ? undefined : render(map);
    } catch {
        note = undefined;
    }
    cache.set(key, { at: Date.now(), note });
    return note;
};
