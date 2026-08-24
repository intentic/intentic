import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { IGNORED_DIRS, isPublicPath, isReferencePath } from "@intentic/workspace-ignore";

/* THE MAP A TURN OPENS WITH, which areas this project has, what each one is for, and where the run is
 * standing among them. Computed from the filesystem at the start of a conversation, never written down.
 *
 * WHY IT EXISTS. Across 100 exploration-heavy sessions of this workspace, the same warm-up was paid over and
 * over: `ls /work` opened 42 of them, a bare directory listing was the first action in 41%, and the first six
 * search/read results came back at a median ~21k characters (~5.3k tokens) before a single line of the actual
 * job was read. The median session then spent 19 read/search calls before its first edit. None of that is the
 * agent wandering: 52 of those sessions reached their eventual target area within two actions, it is a fixed
 * entry toll, and the toll is the part a map removes.
 *
 * WHY IT IS AREAS AND NOT FILES, which is the part that took measuring to believe. Those same 100 sessions read
 * 1,405 distinct files and 1,148 of them (82%) were read by exactly ONE session; 86.6% of session pairs shared
 * no read file at all. There is no common deep path to write down. What IS shared is the top: 88 of 100 sessions
 * edited nowhere but the same six areas. So the top is what this says, and everything below it is left to
 * search, which is better at it.
 *
 * WHY IT IS GENERATED AND NOT A PARAGRAPH IN A PROMPT OR A CLAUDE.md. In the ten days that corpus covers, this
 * repo's two highest-churn top-level directories (`_apps`, `_libs`) stopped existing, and ten sessions went on
 * naming them. A map that is recomputed cannot be wrong about that; a map that is typed always eventually is.
 * The whole design follows from that one property: nothing here is a stored fact, and nothing here is a
 * convention of this repository.
 *
 * NOTHING BELOW KNOWS THIS WORKSPACE. Areas are whatever directories a project actually has, the purpose line is
 * whatever that directory's own manifest or README says, and the container rule that turns `packages/` into
 * areas is written against a shape (a directory of manifest-bearing children) rather than against a list of
 * names. Point it at a Django project or a Cargo workspace and it answers in the same shape.
 *
 * It rides the USER message (turn-preamble.ts), like the retrieved-context note and for the same reason: it is
 * computed per conversation, so it must not sit in a system prefix that is kept byte-stable for the prompt
 * cache, and riding the message is what lets the chat show the reader exactly what was injected. */

export const WORKSPACE_MAP_NOTE_HEADER = "## Map of this project";

/* The note's share of the turn, as characters (~4 per token). Deliberately of the same order as the retrieved
 * context capsule's 1.2k tokens and far under what it replaces: the warm-up it removes measured ~5.3k tokens of
 * tool results. The renderer treats this as a hard ceiling and sheds detail to hold it, purpose lines first,
 * then whole areas, rather than truncating mid-structure. */
const MAX_NOTE_CHARS = 2_800;

// A purpose line longer than this is a paragraph, not a label. Cut at a word boundary.
const MAX_PURPOSE_CHARS = 100;

/* Walk bounds, matching the shape the other workspace walks use (modules.ts, repo-discovery.ts): a pathological
 * tree stops the scan rather than stalling the turn. Depth 4 below an area is enough to make a file count mean
 * something without walking a vendored checkout to the bottom. */
const MAX_AREA_DEPTH = 4;
const MAX_AREA_ENTRIES = 4_000;
// Past this many areas a listing stops being a map. The biggest by file count win; the rest are counted.
const MAX_AREAS = 24;
// How many child directories with manifests make a directory a CONTAINER of areas rather than an area itself.
const CONTAINER_MIN_CHILDREN = 3;

// Manifests that can name a directory's purpose, in the order they are believed. A directory carrying more than
// one (a Python package with a package.json for its tooling) is described by the first that actually says
// something, which is why this is a list and not a lookup.
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
    /* How many packages this area holds, when it is a shelf of them. Always known, it falls out of deciding
     * whether the area is a shelf at all, and always said, so a reader can tell that `packages/` has a level
     * below it even on the runs where that level is not worth spending lines on. */
    readonly packages: number;
    /* Those packages, listed, filled ONLY for the area the run is standing in.
     *
     * The second half of "zoom to the starting position", and it exists because the first draft of this got it
     * wrong in a way worth recording: descending into every container flattened this workspace's 9 areas into 87
     * packages, of which the budget could show 24. The reader lost the level that mattered (which of the nine)
     * to gain a level they had not asked for (which of the eighty-seven), and 63 areas vanished into a footnote.
     * Expanding one container costs a few lines and answers both. */
    readonly children: readonly MapArea[];
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

// A directory that is a directory and that this workspace's conventions do not gray out. `relPath` is
// root-relative so the reference shelf and the outbox are recognised as the TOP-LEVEL directories they are,
// a project's own `public/` is ordinary content and stays.
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

/* WHAT THIS DIRECTORY SAYS IT IS FOR, from its own files and from nowhere else.
 *
 * Order is believability: a manifest description was written to describe the package, a README's opening line
 * was written to open a document and only usually describes it. Both beat an invented sentence, and the empty
 * string beats a guess, an area with nothing to say is listed with its name and its size, which is still more
 * than the agent had. */
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
        // `module github.com/org/thing`, the path is the only self-description a go.mod carries, and its tail
        // is the part that is not boilerplate.
        const module = /^\s*module\s+(\S+)/m.exec(source)?.[1];
        return module === undefined ? undefined : `Go module ${module.split("/").slice(-2).join("/")}`;
    }
    // TOML (pyproject, Cargo) and the JVM manifests: one `description = "…"` / `<description>…</description>`.
    const toml = /^\s*description\s*=\s*["'](.+?)["']\s*$/m.exec(source)?.[1];
    const xml = /<description>([^<]+)<\/description>/.exec(source)?.[1];
    const found = (toml ?? xml)?.trim();
    return found === undefined || found === "" ? undefined : found;
};

/* A README's first line of actual prose. Everything a README opens WITH and is not, the title, badge rows,
 * HTML banners, block quotes, front matter, list items, is stepped over rather than pattern-matched away one
 * by one, because the set of things that are not a sentence is open and the set of things that is one is not. */
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

/* How big an area is and what it is written in, one bounded walk answering both. The count is a SIGNAL, not an
 * inventory: it is there so a reader can tell a core area from a scratch folder, which is a judgement the number
 * supports long before it is exact. Bounded on both axes for the usual reason, and the bound is why the count is
 * reported as what it is rather than promised as complete. */
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

/* WHICH PROJECT THE RUN IS IN, the nearest git boundary at or above the starting folder, floored at the
 * workspace root.
 *
 * This is the whole "starting position" idea in one function. A turn does not start at /work: it starts in a
 * persona's declared folder, or in an isolated conversation's worktree, or in whatever repo the user was last
 * looking at. Mapping the workspace from the top for a run that begins three levels inside one project answers
 * a question nobody asked and buries the one they did.
 *
 * A workspace with no git anywhere still gets a map, the root is the project, because a directory of code is
 * a project whether or not anyone has run `git init` in it. */
const projectRootOf = (root: string, cwd: string): string => {
    let current = cwd;
    for (;;) {
        try {
            // `.git` is a directory in an ordinary clone and a POINTER FILE in a worktree, a submodule, and in
            // this daemon's own --separate-git-dir repos. Either one is a boundary; only its presence matters.
            statSync(join(current, ".git"));
            return current;
        } catch {
            // No boundary here, keep climbing.
        }
        if (current === root || current === dirname(current)) {
            return root;
        }
        const parent = dirname(current);
        // A cwd outside the root (it should not happen; the escape guard is upstream) stops at the root rather
        // than climbing out of the workspace.
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

/* IS THIS DIRECTORY A SHELF RATHER THAN AN AREA, `packages/`, `apps/`, `libs/`, `crates/`, `cmd/`, `services/`,
 * and whatever the next ecosystem decides to call it.
 *
 * Written against the SHAPE and not against a list of names, which is the single decision that makes this work
 * in a repository nobody here has seen. A name list is wrong the first time it meets a convention it was not
 * taught; "a directory of manifest-bearing directories, which is not itself a package" is what the layout MEANS
 * in every ecosystem that has one, and it needs no vocabulary at all. */
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

/* THE AREAS OF A PROJECT, its own top-level directories, with one exception.
 *
 * The exception is the repository that IS a container: a root holding `packages/` and little else. Its top level
 * is not a map of anything, so the packages are promoted to being the areas. The test is structural like
 * everything else here, one or two browsable directories at the root, of which one is a shelf.
 *
 * Every other project keeps its top level, and a shelf among those directories stays one line until the run
 * turns out to be standing inside it. That is the difference between a map and a listing. */
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

/* The map, or undefined when there is nothing worth saying, a project with one area or none is one the agent
 * can see in a single listing, and a note about it would be pure overhead. */
export const workspaceMapOf = ({ root, cwd }: WorkspaceMapInput): WorkspaceMap | undefined => {
    const projectRoot = projectRootOf(root, cwd);
    const found = areaDirsOf(projectRoot, root);
    if (found.length < 2) {
        return undefined;
    }
    const cwdRel = posix(relative(projectRoot, cwd));
    // The run is "in" the area that is a prefix of the starting folder, `_editor` for a cwd of
    // `_editor/web/src`, and no area at all for a run starting at the project root.
    const isHere = (name: string): boolean => cwdRel === name || cwdRel.startsWith(`${name}/`);
    // A package inside a shelf is never itself expanded: one level of zoom is the point, and two is the
    // flattening this design already had to be walked back from.
    const asArea = (name: string, dir: string, packages: number, children: readonly MapArea[]): MapArea => {
        const { files, kinds } = measure(dir, root);
        return { name, files, kinds, purpose: purposeOf(dir), here: isHere(name), packages, children };
    };
    const measured = found.map(({ name, dir, packages }): MapArea => {
        /* The shelf's packages are measured only for the shelf the run is inside. Walking every package of every
         * shelf to print a number nobody will read is what this lazily avoids, on this workspace that is 87
         * walks against 9, and it is the same restraint the note itself is an argument for. */
        const children = isHere(name)
            ? packages
                  .map((entry) => asArea(`${name}/${entry.name}`, entry.dir, 0, []))
                  .toSorted((left, right) => right.files - left.files || left.name.localeCompare(right.name))
            : [];
        return asArea(name, dir, packages.length, children);
    });
    // Biggest first: with a budget to hold, the areas most of the work is in are the ones worth the characters.
    const ranked = measured.toSorted((left, right) => right.files - left.files || left.name.localeCompare(right.name));
    const kept = ranked.slice(0, MAX_AREAS);
    // An area the run is standing in is never dropped for being small, it is the one line the reader is
    // certain to want.
    const here = ranked.slice(MAX_AREAS).filter((area) => area.here);
    const areas = [...kept, ...here];
    return {
        project: posix(relative(root, projectRoot)),
        cwd: posix(relative(root, cwd)),
        areas,
        omitted: ranked.length - areas.length,
        // Only meaningful when the project is not the whole workspace: what else is out there, named so the
        // agent knows it exists without being told anything about it.
        siblings: projectRoot === root ? [] : childDirs(root, root).filter((name) => name !== basename(projectRoot)),
    };
};

const sizeOf = (area: MapArea): string =>
    `${area.files} file${area.files === 1 ? "" : "s"}${area.kinds.length > 0 ? ` · ${area.kinds.join(", ")}` : ""}` +
    // Said on the shelf's line so a reader knows there is a level below whether or not it is shown one.
    (area.packages > 0 ? ` · ${area.packages} packages` : "");

const areaLine = (area: MapArea, width: number, indent: string): string =>
    `${indent}${area.name.padEnd(width - indent.length)}  ${sizeOf(area)}${area.here && area.children.length === 0 ? "  ← you are here" : ""}`;

// Every line an area contributes: itself, its purpose where the budget still allows one, and the packages below
// it when it is the one the run is standing in.
const areaBlock = (area: MapArea, width: number, silent: ReadonlySet<string>): string[] => [
    areaLine(area, width, "  "),
    ...(area.purpose === "" || silent.has(area.name) ? [] : [`  ${" ".repeat(width - 2)}  ${area.purpose}`]),
    ...area.children.flatMap((child) => [
        areaLine(child, width, "      "),
        ...(child.purpose === "" || silent.has(child.name) ? [] : [`      ${" ".repeat(width - 6)}  ${child.purpose}`]),
    ]),
];

/* THE NOTE, rendered to fit. Detail is shed in the order it is worth least: the purpose lines of the smallest
 * areas go first (a name and a size still locate an area), then whole small areas, and what went is counted out
 * loud rather than quietly dropped, a list that silently stops reads as a complete list, which is the one way
 * a map can be actively misleading. */
const render = (map: WorkspaceMap): string => {
    const project = map.project === "" ? "the workspace" : `\`${map.project}\``;
    const all = map.areas.flatMap((area) => [area, ...area.children]);
    // The size column starts past the longest name AT ITS OWN INDENT, an expanded package is indented four
    // further, and measuring names alone is what left one row's columns hanging off the end of the others.
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
    /* Every purpose is already gone and the names alone still overflow, a project with a great many areas. Keep
     * the head, keep as many lines as fit, and say how many did not. */
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

/* Cached per project directory, because the walk is cheap but not free and a busy sandbox opens conversations in
 * bursts. Short TTL rather than watcher invalidation on purpose: the ENTIRE value of this note is that it cannot
 * go stale, and a minute is well inside the window where being wrong would matter while still collapsing a
 * burst. A slower, exactly-invalidated cache would be trading the property the feature exists for. */
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; note: string | undefined }>();

/* The note for a turn, or undefined when there is nothing worth injecting.
 *
 * SWALLOWS ITS OWN FAILURES, like the retrieved-context note and for the same reason: this is help the user did
 * not ask for on this turn, so an unreadable directory or a filesystem that moved mid-walk must cost the note
 * and nothing else. Killing a turn over a failed convenience would make the feature worse than not having it. */
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
