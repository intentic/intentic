// Which dependency manager a project needs, decided from its manifest/lockfile NAMES alone, pure, no I/O and
// no node imports, so both sides can run it: the browser over a drag-drop's file list BEFORE a byte uploads
// (useUploadQueue offers the install as part of the import), and the daemon over a readdir of what landed
// (workspace-setup.ts answers "is this project ready?").
//
// A drop deliberately omits node_modules/.venv (dropEntries' IGNORED_DIRS), uploading a dependency tree over
// HTTP would be slow AND wrong, since it was built against the laptop's OS/glibc, not this container's. So the
// tree arrives sound but unusable: tests can't run, and the agent's post-edit type-check reports every import
// as broken. Naming the manager is what lets the product close that gap instead of leaving the user to notice.
//
// Node ships alone today because it is the only ecosystem whose manager is baked into the sandbox image
// (pnpm/npm/yarn via corepack). Python's entries are here because python3 is baked and the shape generalizes;
// the daemon gates every recipe on the manager actually being on PATH (setupStateOf), so a detected-but-absent
// manager surfaces as "unsupported" with the binary named, never as an install that fails in a terminal.
// Adding rust/go/ruby is a row in the tables below plus that manager in the image, no other change.

export type Ecosystem = "node" | "python";

export interface SetupRecipe {
    readonly ecosystem: Ecosystem;
    // The CLI the install runs through. Also what the daemon looks for on PATH before offering the recipe, so
    // it must be the real binary name, not a display label.
    readonly manager: string;
    // The install command, run from the project directory.
    readonly command: string;
    // The file that decided the manager ("pnpm-lock.yaml"), shown in the UI so the choice is never opaque,
    // the user can see we read their lockfile rather than guessed.
    readonly evidence: string;
    // The directory whose presence means the install already happened, relative to the project dir. The daemon
    // checks it to distinguish "needs setup" from "ready"; the browser can't (a drop never carries it).
    readonly marker: string;
}

// A project directory and what it needs. `dir` is relative to whatever root the paths were relative to, the
// drop root in the browser, the workspace root on the daemon; "" means the root itself owns the manifest.
export interface ProjectSetup {
    readonly dir: string;
    readonly recipe: SetupRecipe;
}

// Lockfile → manager, most specific first. A repo carrying two lockfiles (a half-finished migration) resolves
// to the first match rather than asking the user to arbitrate; `packageManager` below overrides it anyway.
const NODE_LOCKFILES: readonly (readonly [file: string, manager: string])[] = [
    ["pnpm-lock.yaml", "pnpm"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
];

// The managers a `packageManager` field may name. An unknown value is ignored rather than trusted: the field
// reaches us from an arbitrary uploaded package.json and its manager name becomes a shell command.
const NODE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);

const nodeRecipe = (manager: string, evidence: string): SetupRecipe => ({
    ecosystem: "node",
    manager,
    command: `${manager} install`,
    evidence,
    marker: "node_modules",
});

// Lockfile/manifest → manager + command, most specific first. requirements.txt has no lockfile-grade intent,
// so it gets the portable stdlib answer (a local .venv) rather than assuming a third-party manager.
const PYTHON_RECIPES: readonly (readonly [file: string, manager: string, command: string])[] = [
    ["uv.lock", "uv", "uv sync"],
    ["poetry.lock", "poetry", "poetry install"],
    ["Pipfile.lock", "pipenv", "pipenv install --dev"],
    ["requirements.txt", "python3", "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"],
    ["pyproject.toml", "uv", "uv sync"],
];

const PYTHON_MARKER = ".venv";

// The `packageManager` field (corepack's explicit declaration) beats any lockfile, it is what the project SAYS
// it uses, where a lockfile is only evidence of what someone last ran. Returns undefined for absent, malformed,
// or unrecognized values; the caller then falls back to the lockfile.
export const managerFromPackageJson = (text: string): string | undefined => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) {
        return undefined;
    }
    const field = (parsed as { packageManager?: unknown }).packageManager;
    if (typeof field !== "string") {
        return undefined;
    }
    // "pnpm@11.13.1+sha512.…" → "pnpm". Corepack forbids a scope here, so a leading "@" is malformed, not a
    // scoped name, slicing at the first "@" would yield "" and fall through to the whitelist rejection anyway.
    const name = field.split("@")[0] ?? "";
    return NODE_MANAGERS.has(name) ? name : undefined;
};

// Every file whose presence at the top of a directory makes it a project root worth a recipe.
const MANIFESTS = new Set(["package.json", ...NODE_LOCKFILES.map(([file]) => file), ...PYTHON_RECIPES.map(([file]) => file)]);

export const isManifest = (name: string): boolean => MANIFESTS.has(name);

// The recipe for ONE directory, from its immediate entry names. `packageManagerField` is the parsed
// `packageManager` value when the caller has already read package.json (the browser reads the dropped File;
// the daemon reads it off disk), omit it and detection falls back to lockfiles, which is correct but coarser.
export const recipeFor = (names: readonly string[], packageManagerField?: string): SetupRecipe | undefined => {
    const has = (name: string): boolean => names.includes(name);
    if (has("package.json")) {
        if (packageManagerField !== undefined && NODE_MANAGERS.has(packageManagerField)) {
            return nodeRecipe(packageManagerField, "the packageManager field");
        }
        const lock = NODE_LOCKFILES.find(([file]) => has(file));
        // No lockfile at all: npm is the answer that always works, and `evidence` says plainly that we're going
        // on the manifest alone so the user can correct us before it runs.
        return lock === undefined ? nodeRecipe("npm", "package.json (no lockfile)") : nodeRecipe(lock[1], lock[0]);
    }
    const python = PYTHON_RECIPES.find(([file]) => has(file));
    if (python !== undefined) {
        return { ecosystem: "python", manager: python[1], command: python[2], evidence: python[0], marker: PYTHON_MARKER };
    }
    return undefined;
};

// The directory part of a root-relative path ("" for a root-level file). Slash-joined, matching the drop walk.
const dirOf = (path: string): string => {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? "" : path.slice(0, slash);
};

const isAncestor = (ancestor: string, dir: string): boolean => ancestor === "" || dir.startsWith(`${ancestor}/`);

// Every project in a flat list of root-relative file paths. Only the SHALLOWEST manifest on each branch wins:
// a monorepo installs once from its root (the workspace manager resolves the members), so descending into
// _apps/*/package.json would propose N redundant installs of the same tree. Two unrelated projects dropped
// side by side still get one each, neither is an ancestor of the other.
//
// `packageManagerFields` maps a project dir to that dir's parsed `packageManager` value, for callers that read
// the manifests up front. Unknown dirs simply fall back to lockfile detection.
export const detectProjects = (paths: readonly string[], packageManagerFields?: ReadonlyMap<string, string>): readonly ProjectSetup[] => {
    const byDir = new Map<string, string[]>();
    for (const path of paths) {
        const dir = dirOf(path);
        const name = path.slice(dir === "" ? 0 : dir.length + 1);
        const names = byDir.get(dir);
        if (names === undefined) {
            byDir.set(dir, [name]);
        } else {
            names.push(name);
        }
    }
    // Shallowest first (then lexical, so the result is stable for the same drop regardless of walk order,
    // dropEntries walks concurrently and its output order is explicitly non-deterministic).
    const candidates = Array.from(byDir.entries())
        .filter(([, names]) => names.some(isManifest))
        .map(([dir, names]) => ({ dir, names, depth: dir === "" ? 0 : dir.split("/").length }))
        .toSorted((left, right) => left.depth - right.depth || left.dir.localeCompare(right.dir));
    const projects: ProjectSetup[] = [];
    for (const { dir, names } of candidates) {
        if (projects.some((project) => isAncestor(project.dir, dir))) {
            continue;
        }
        const recipe = recipeFor(names, packageManagerFields?.get(dir));
        if (recipe !== undefined) {
            projects.push({ dir, recipe });
        }
    }
    return projects;
};
