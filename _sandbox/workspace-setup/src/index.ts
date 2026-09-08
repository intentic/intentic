// Pure, no I/O: decides a project's dependency manager from manifest/lockfile names, so both the browser (pre-upload)
// and the daemon (post-drop) can run it. A drop omits node_modules/.venv (wrong OS anyway); naming the manager closes
// that gap. Node and Python are supported because their managers are baked into the sandbox image.

export type Ecosystem = "node" | "python";

export interface SetupRecipe {
    readonly ecosystem: Ecosystem;
    // The real binary name, not a display label; the daemon checks it on PATH before offering the recipe.
    readonly manager: string;
    // The install command, run from the project directory.
    readonly command: string;
    // The file that decided the manager (e.g. "pnpm-lock.yaml"), shown in the UI so the choice isn't opaque.
    readonly evidence: string;
    // Directory whose presence means install already happened; only the daemon can check it, a drop never has it.
    readonly marker: string;
}

// `dir` is relative to whatever root the paths were relative to (drop root in the browser, workspace root on the
// daemon); "" means the root itself owns the manifest.
export interface ProjectSetup {
    readonly dir: string;
    readonly recipe: SetupRecipe;
}

// Lockfile to manager, most specific first; two lockfiles resolve to the first match, packageManager overrides.
const NODE_LOCKFILES: readonly (readonly [file: string, manager: string])[] = [
    ["pnpm-lock.yaml", "pnpm"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
];

// Managers a `packageManager` field may name; an unrecognized value is ignored (it becomes a shell command).
const NODE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);

const nodeRecipe = (manager: string, evidence: string): SetupRecipe => ({
    ecosystem: "node",
    manager,
    command: `${manager} install`,
    evidence,
    marker: "node_modules",
});

// Lockfile/manifest to manager+command, most specific first; requirements.txt gets a stdlib venv, not a guess.
const PYTHON_RECIPES: readonly (readonly [file: string, manager: string, command: string])[] = [
    ["uv.lock", "uv", "uv sync"],
    ["poetry.lock", "poetry", "poetry install"],
    ["Pipfile.lock", "pipenv", "pipenv install --dev"],
    ["requirements.txt", "python3", "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"],
    ["pyproject.toml", "uv", "uv sync"],
];

const PYTHON_MARKER = ".venv";

// packageManager (corepack's declaration) beats any lockfile: it says what the project uses, a lockfile only what ran
// last. Undefined for absent/malformed/unrecognized; caller falls back to lockfiles.
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
    // "pnpm@11.13.1+sha512..." to "pnpm"; a leading "@" is malformed (no scope in corepack) and falls to rejection.
    const name = field.split("@")[0] ?? "";
    return NODE_MANAGERS.has(name) ? name : undefined;
};

// Every top-of-directory file that makes a directory a project root worth a recipe.
export const MANIFESTS: ReadonlySet<string> = new Set([
    "package.json",
    ...NODE_LOCKFILES.map(([file]) => file),
    ...PYTHON_RECIPES.map(([file]) => file),
]);

export const isManifest = (name: string): boolean => MANIFESTS.has(name);

// Recipe for one directory from its entry names. `packageManagerField`, when the caller already parsed package.json,
// skips falling back to lockfile detection.
export const recipeFor = (names: readonly string[], packageManagerField?: string): SetupRecipe | undefined => {
    const has = (name: string): boolean => names.includes(name);
    if (has("package.json")) {
        if (packageManagerField !== undefined && NODE_MANAGERS.has(packageManagerField)) {
            return nodeRecipe(packageManagerField, "the packageManager field");
        }
        const lock = NODE_LOCKFILES.find(([file]) => has(file));
        // No lockfile: npm always works; evidence says plainly it's a manifest-only guess.
        return lock === undefined ? nodeRecipe("npm", "package.json (no lockfile)") : nodeRecipe(lock[1], lock[0]);
    }
    const python = PYTHON_RECIPES.find(([file]) => has(file));
    if (python !== undefined) {
        return { ecosystem: "python", manager: python[1], command: python[2], evidence: python[0], marker: PYTHON_MARKER };
    }
    return undefined;
};

// Directory part of a root-relative path ("" for a root-level file), slash-joined like the drop walk.
const dirOf = (path: string): string => {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? "" : path.slice(0, slash);
};

const isAncestor = (ancestor: string, dir: string): boolean => ancestor === "" || dir.startsWith(`${ancestor}/`);

// Every project in a flat list of paths; the shallowest manifest per branch wins, so a monorepo installs once from its
// root. `packageManagerFields` maps a dir to its parsed value; unknown dirs fall back to lockfiles.
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
    // Shallowest first, then lexical, so the result is stable despite the drop's non-deterministic walk order.
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
