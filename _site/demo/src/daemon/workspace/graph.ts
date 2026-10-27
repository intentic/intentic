import { refuse } from "@intentic/contract-serve";
import type { PackageModules, WorkspaceDepEdge, WorkspaceDepUsage, WorkspaceGraph, WorkspacePackage } from "@intentic/sandbox-contract/schemas/workspace/workspace-graph";
import type { WorkspaceModules } from "@intentic/sandbox-contract/schemas/git/git";
import { fileBody, workspaceEntries } from "../../fixture/workspace";
import { type PackageManifest, readManifest } from "./manifests";
import { monorepoOf, workspaceRepos } from "./repos";

// A monorepo's architecture read from its files, the way the daemon's readers do: the packages pnpm-workspace.yaml's
// globs reach, the siblings each declares and what its own files do with them, and inside one package the imports
// between its source folders, placed in the layers its layers.json declares. Nothing here is recorded: an app added to
// the repo shows up because its package.json does.

const SOURCE = /\.(?:[cm]?[jt]sx?)$/u;
const TOOLING = /(?:\.test\.|\.spec\.|(?:^|\/)(?:scripts|tests?)\/|\.config\.)/u;

// The globs of pnpm-workspace.yaml's `packages:` list; only `dir/*` and plain dirs, which is all this layout uses.
const workspaceGlobs = (repo: string): string[] =>
    [...(fileBody(`${repo}/pnpm-workspace.yaml`) ?? ``).matchAll(/^\s*-\s*["']?([^"'\n]+)["']?\s*$/gmu)].map((match) => match[1] ?? ``);

interface Found {
    readonly dir: string;
    readonly manifest: PackageManifest & { readonly name: string };
}

const packagesOf = (repo: string): Found[] => {
    const globs = workspaceGlobs(repo);
    const found: Found[] = [];
    for (const path of workspaceEntries().keys()) {
        if (!path.startsWith(`${repo}/`) || !path.endsWith(`/package.json`) || path.includes(`/node_modules/`)) {
            continue;
        }
        const dir = path.slice(repo.length + 1, -`/package.json`.length);
        const reached = globs.some((glob) => (glob.endsWith(`/*`) ? dir.startsWith(glob.slice(0, -1)) && !dir.slice(glob.length - 1).includes(`/`) : dir === glob));
        const manifest = readManifest(path);
        if (reached && manifest?.name !== undefined) {
            found.push({ dir, manifest: { ...manifest, name: manifest.name } });
        }
    }
    return found.toSorted((left, right) => left.dir.localeCompare(right.dir));
};

// A package's source files, package-relative, with their text.
const sourcesOf = (repo: string, dir: string): [string, string][] =>
    [...workspaceEntries().keys()]
        .filter((path) => path.startsWith(`${repo}/${dir}/`) && SOURCE.test(path))
        .map((path): [string, string] => [path.slice(repo.length + dir.length + 2), fileBody(path) ?? ``]);

// The strongest use the dependent's own files make of `name`: a shipped value import, then types only, then tooling.
const usageOf = (sources: readonly [string, string][], name: string): WorkspaceDepUsage => {
    const pattern = new RegExp(`^\\s*import\\s+(type\\s+)?[^;]*?from\\s+["']${name.replaceAll(`/`, `\\/`)}(?:\\/[^"']*)?["']`, `gmu`);
    let usage: WorkspaceDepUsage = `none`;
    for (const [path, body] of sources) {
        for (const match of body.matchAll(pattern)) {
            if (TOOLING.test(path)) {
                usage = usage === `none` ? `tooling` : usage;
            } else if (match[1] === undefined) {
                return `code`;
            } else {
                usage = `types`;
            }
        }
    }
    return usage;
};

/** GET /workspace/repos/{repo}/graph */
export const packageGraph = (repo: string): WorkspaceGraph => {
    monorepoOf(repo);
    const found = packagesOf(repo);
    const names = new Set(found.map((pkg) => pkg.manifest.name));
    const packages: WorkspacePackage[] = found.map(({ dir, manifest }) => ({ name: manifest.name, dir, group: dir.split(`/`)[0] ?? dir }));
    const edges: WorkspaceDepEdge[] = found.flatMap(({ dir, manifest }) => {
        const sources = sourcesOf(repo, dir);
        const blocks = [
            [`prod`, manifest.dependencies],
            [`dev`, manifest.devDependencies],
            [`peer`, manifest.peerDependencies],
        ] as const;
        return blocks.flatMap(([type, deps]) =>
            Object.keys(deps ?? {})
                .filter((dep) => names.has(dep))
                .map((dep) => ({ from: manifest.name, to: dep, type, usage: usageOf(sources, dep) })),
        );
    });
    return { packages, edges };
};

interface LayerFile {
    readonly root?: string;
    readonly layers: readonly { readonly name: string; readonly about?: string; readonly units: readonly string[] }[];
}

// A package's layers.json: what it declares, or why it could not be read.
interface LayersRead {
    readonly layers?: LayerFile;
    readonly invalid?: string;
}

const readLayers = (path: string): LayersRead => {
    const body = fileBody(path);
    if (body === undefined) {
        return {};
    }
    try {
        // SAFETY: checked just below for the one field every reader needs, a list of layers.
        const parsed = JSON.parse(body) as LayerFile;
        return Array.isArray(parsed.layers) && parsed.layers.length > 0 ? { layers: parsed } : { invalid: `layers.json declares no layers` };
    } catch (failure) {
        return { invalid: `layers.json does not parse: ${failure instanceof Error ? failure.message : String(failure)}` };
    }
};

// The unit a module sits in: its first folder under the root, or "(root)" for one directly in it.
const unitOf = (path: string): string => (path.includes(`/`) ? path.slice(0, path.indexOf(`/`)) : `(root)`);

const resolveRelative = (from: string, spec: string): string => {
    const parts = from.split(`/`).slice(0, -1);
    for (const segment of spec.split(`/`)) {
        if (segment === `..`) {
            parts.pop();
        } else if (segment !== `.`) {
            parts.push(segment);
        }
    }
    return parts.join(`/`);
};

/** GET /workspace/repos/{repo}/layers */
export const packageModules = (repo: string, name: string): PackageModules => {
    monorepoOf(repo);
    const found = packagesOf(repo).find((pkg) => pkg.manifest.name === name) ?? refuse(`no workspace package "${name}" in ${repo}`, 404);
    const { layers, invalid } = readLayers(`${repo}/${found.dir}/layers.json`);
    const root = layers?.root ?? `src`;
    const modules = sourcesOf(repo, `${found.dir}/${root}`).filter(([path]) => !TOOLING.test(path));
    const units = new Map<string, number>();
    const edges = new Map<string, { from: string; to: string; imports: number; sites: string[] }>();
    for (const [path, body] of modules) {
        const from = unitOf(path);
        units.set(from, (units.get(from) ?? 0) + 1);
        for (const [index, line] of body.split(`\n`).entries()) {
            const spec = /^\s*import\s+(?!type\s)[^;]*?from\s+["'](\.[^"']*)["']/u.exec(line)?.[1];
            const to = spec === undefined ? undefined : unitOf(resolveRelative(path, spec));
            if (to === undefined || to === from) {
                continue;
            }
            const edge = edges.get(`${from}>${to}`) ?? { from, to, imports: 0, sites: [] };
            edge.imports += 1;
            if (edge.sites.length < 5) {
                edge.sites.push(`${path}:${index + 1}`);
            }
            edges.set(`${from}>${to}`, edge);
        }
    }
    const layerOf = (unit: string): number | undefined => {
        const index = layers?.layers.findIndex((layer) => layer.units.includes(unit)) ?? -1;
        return index === -1 ? undefined : index;
    };
    const answer: PackageModules = {
        package: name,
        root: `${found.dir}/${root}`,
        units: [...units].map(([id, count]) => {
            const layer = layerOf(id);
            return layer === undefined ? { id, modules: count } : { id, modules: count, layer };
        }),
        edges: [...edges.values()],
    };
    if (layers !== undefined) {
        answer.layers = layers.layers.map((layer) => (layer.about === undefined ? { name: layer.name } : { name: layer.name, about: layer.about }));
    }
    if (invalid !== undefined) {
        answer.invalid = invalid;
    }
    return answer;
};

/** GET /workspace/modules: every repo's named packages, `root` first, the way the Changes review groups by them. */
export const workspaceModules = (): WorkspaceModules => ({
    repos: [
        { repo: `root`, modules: [] },
        ...workspaceRepos().map((repo) => {
            const own = readManifest(`${repo}/package.json`)?.name;
            const members = packagesOf(repo).map(({ dir, manifest }) => ({ dir, name: manifest.name }));
            return { repo, modules: [...(own === undefined ? [] : [{ dir: ``, name: own }]), ...members] };
        }),
    ],
});
