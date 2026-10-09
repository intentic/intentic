import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import {
    type PackageLayersFile,
    PackageLayersFileSchema,
    type PackageModules,
    type PackageUnit,
    type PackageUnitEdge,
} from "@intentic/sandbox-contract";
import { importsOf } from "./import-scan.js";
import { packageFiles, readSources } from "./package-files.js";
import { isTooling } from "./package-usage.js";
import type { WorkspaceManifest } from "./package-graph.js";

// One package's insides: its modules grouped into units (a top-level directory of its root, or a shelf's subdirectory,
// or the unit its layers.json names), and the value imports between units. With a layers.json each unit carries its
// layer, the same table the repository's own boundary checks read (_tools/checks/lib/daemon-layers.mjs reads
// _sandbox/sandbox/layers.json), so what the view calls an upward import is what the check refuses.

export const LAYERS_FILE = "layers.json";
const SCRIPT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
// The files directly in the root (main.ts, app.ts, router.ts and their helpers): what wires every unit together. Placed
// in no layer and judged by neither rule, as the boundary checks leave them.
export const ROOT_UNIT = "(root)";
// Every surface module, wherever it sits (a route module in each subsystem): one unit above every layer, since what a
// surface module imports is never judged and only an import INTO one is.
export const SURFACE_UNIT = "(surface)";
const SITES_KEPT = 5;

const globOf = (pattern: string): RegExp =>
    new RegExp(
        `^${pattern
            .split("*")
            .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join("[^/]*")}$`,
    );

interface Declared {
    readonly file: PackageLayersFile | undefined;
    readonly invalid: string | undefined;
}

const readDeclared = (packageDir: string): Declared => {
    let text: string | undefined;
    try {
        text = readFileSync(join(packageDir, LAYERS_FILE), "utf8");
    } catch (error) {
        text = undefinedIfMissing(error);
    }
    if (text === undefined) {
        return { file: undefined, invalid: undefined };
    }
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch (error) {
        return { file: undefined, invalid: `${LAYERS_FILE} is not JSON: ${(error as Error).message}` };
    }
    const parsed = PackageLayersFileSchema.safeParse(json);
    return parsed.success
        ? { file: parsed.data, invalid: undefined }
        : {
              file: undefined,
              invalid: `${LAYERS_FILE} does not match its shape: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
          };
};

interface Place {
    readonly unit: string;
    readonly layer: number | undefined;
    readonly surface: boolean;
}

/** Where a module (a path relative to the root) sits: its unit, its layer, and whether it is surface. */
export const placer = (file: PackageLayersFile | undefined): ((path: string) => Place) => {
    const units = (file?.layers ?? [])
        .flatMap(({ units: prefixes }, layer) => prefixes.map((unit) => ({ unit, layer })))
        .toSorted((a, b) => b.unit.length - a.unit.length);
    const shelves = new Set(file?.shelves ?? []);
    const surface = (file?.surface ?? []).map(globOf);
    return (path) => {
        const parts = path.split("/");
        if (parts.length === 1) {
            return { unit: ROOT_UNIT, layer: undefined, surface: false };
        }
        if (surface.some((pattern) => pattern.test(parts.at(-1)!))) {
            return { unit: SURFACE_UNIT, layer: undefined, surface: true };
        }
        const placed = units.find(({ unit }) => path === unit || path.startsWith(`${unit}/`) || path.startsWith(`${unit}.`));
        const shelved = shelves.has(parts[0]!) && parts.length > 2 ? `${parts[0]}/${parts[1]}` : undefined;
        // A shelf's subdirectory is its own unit unless the table names a longer one inside it.
        const unit = placed !== undefined && placed.unit.split("/").length > 1 ? placed.unit : (shelved ?? placed?.unit ?? parts[0]!);
        return { unit, layer: placed?.layer, surface: false };
    };
};

// The module a relative specifier names among `modules`: the file itself, its compiled name's source (`./x.js` for
// x.ts), an extensionless name, or a directory's index.
const resolveIn = (modules: ReadonlySet<string>, from: string, specifier: string): string | undefined => {
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    const compiled = base.replace(/\.([cm]?)js$/, ".$1ts");
    return [
        base,
        compiled,
        compiled.replace(/\.ts$/, ".tsx"),
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.js`,
        `${base}.vue`,
        `${base}/index.ts`,
        `${base}/index.js`,
    ].find((candidate) => modules.has(candidate));
};

/** One package's units and the value imports between them; undefined when no package has that name. */
export const readPackageModules = async (
    repoDir: string,
    manifests: readonly WorkspaceManifest[],
    name: string,
): Promise<PackageModules | undefined> => {
    const found = manifests.find((manifest) => manifest.name === name);
    if (found === undefined) {
        return undefined;
    }
    const { file, invalid } = readDeclared(join(repoDir, found.dir));
    const rootIn = file?.root ?? (existsSync(join(repoDir, found.dir, "src")) ? "src" : "");
    const root = rootIn === "" ? found.dir : `${found.dir}/${rootIn.replace(/^\.?\/+|\/+$/g, "")}`;
    const relative = (path: string): string => path.slice(root.length + 1);
    const paths = (await packageFiles(repoDir, [root])).filter(
        (path) => SCRIPT.test(path) && !DECLARATION.test(path) && !path.includes("/node_modules/") && !isTooling(relative(path)),
    );
    const modules = new Set(paths.map(relative));
    const place = placer(file);

    const units = new Map<string, PackageUnit & { modules: number }>();
    for (const path of modules) {
        const { unit, layer, surface } = place(path);
        const held = units.get(unit);
        if (held !== undefined) {
            held.modules += 1;
        } else {
            units.set(unit, { id: unit, modules: 1, ...(layer !== undefined ? { layer } : {}), ...(surface ? { surface: true as const } : {}) });
        }
    }

    const edges = new Map<string, { from: string; to: string; imports: number; sites: string[] }>();
    await readSources(repoDir, paths, (path, text) => {
        const from = relative(path);
        const source = place(from).unit;
        for (const { specifier, typeOnly, line } of importsOf(path, text)) {
            const target = typeOnly || !specifier.startsWith(".") ? undefined : resolveIn(modules, from, specifier);
            const to = target === undefined ? undefined : place(target).unit;
            if (to === undefined || to === source) {
                continue;
            }
            const key = `${source}>${to}`;
            const edge = edges.get(key) ?? edges.set(key, { from: source, to, imports: 0, sites: [] }).get(key)!;
            edge.imports += 1;
            if (edge.sites.length < SITES_KEPT) {
                edge.sites.push(`${from}:${line}`);
            }
        }
    });

    const byId = (a: { id: string }, b: { id: string }): number => a.id.localeCompare(b.id);
    const sortedEdges: PackageUnitEdge[] = [...edges.values()]
        .map((edge) => ({ ...edge, sites: edge.sites.toSorted() }))
        .toSorted((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    return {
        package: name,
        root,
        ...(file !== undefined
            ? { layers: file.layers.map(({ name: layer, about }) => ({ name: layer, ...(about !== undefined ? { about } : {}) })) }
            : {}),
        ...(invalid !== undefined ? { invalid } : {}),
        units: [...units.values()].toSorted(byId),
        edges: sortedEdges,
    };
};
