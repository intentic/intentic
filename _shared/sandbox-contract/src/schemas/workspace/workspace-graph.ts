import { z } from "zod";

// A monorepo's architecture as its files state it: the packages pnpm-workspace.yaml names, which siblings each declares
// and what its own files do with them, and, inside one package, how its modules import each other. Facts only: what to
// draw, and what counts as a finding, is the reader's.

// A component of the repository's map, docs/architecture/repo.json, which the documentation extension writes.
export const WorkspaceComponentSchema = z.object({
    id: z.string().describe("The component's id."),
    name: z.string().describe("What the map calls it."),
    accent: z.string().optional().describe('The map\'s colour slot for it: "1" to "5", or "neutral".'),
});
export type WorkspaceComponent = z.infer<typeof WorkspaceComponentSchema>;

// A pnpm-workspace package, discovered from pnpm-workspace.yaml's globs. group is the top-level dir segment; component
// is the repo.json component listing its dir, when the repository has a map.
export const WorkspacePackageSchema = z.object({
    name: z.string().describe("The name the package declares."),
    dir: z.string().describe("Where it lives, relative to the repository."),
    group: z.string().describe("The top-level folder it sits under, which is what a diagram colours by."),
    component: z.string().optional().describe("The component of docs/architecture/repo.json that lists it, by id. Absent without a map."),
});
export type WorkspacePackage = z.infer<typeof WorkspacePackageSchema>;
export const WorkspaceDepTypeSchema = z.enum(["prod", "dev", "peer"]);
export type WorkspaceDepType = z.infer<typeof WorkspaceDepTypeSchema>;

// What the dependent's own files do with a sibling it declares, read from them: the strongest use found wins.
export const WorkspaceDepUsageSchema = z
    .enum(["code", "types", "tooling", "reference", "none"])
    .describe(
        "What the dependent's own files do with it: `code`, a shipped file imports a value from it; `types`, shipped files import only its types; `tooling`, only its tests, scripts and config files use it; `reference`, a shipped file names it without importing it (a Dockerfile copying its build, a manifest listing its files); `none`, nothing in the dependent names it.",
    );
export type WorkspaceDepUsage = z.infer<typeof WorkspaceDepUsageSchema>;

// A workspace-internal dependency edge: from depends on to, typed by which dependency block declared it.
export const WorkspaceDepEdgeSchema = z.object({
    from: z.string().describe("The package that depends."),
    to: z.string().describe("The package it depends on."),
    type: WorkspaceDepTypeSchema.describe("Which kind of dependency declared it."),
    usage: WorkspaceDepUsageSchema.optional(),
});
export type WorkspaceDepEdge = z.infer<typeof WorkspaceDepEdgeSchema>;
export const WorkspaceGraphSchema = z.object({
    packages: z.array(WorkspacePackageSchema).describe("Every package in the repository."),
    edges: z.array(WorkspaceDepEdgeSchema).describe("Which of them use which. Pure data: how to lay it out is yours to decide."),
    components: z
        .array(WorkspaceComponentSchema)
        .optional()
        .describe("The components of docs/architecture/repo.json, in the map's order. Absent when the repository has no map."),
});
export type WorkspaceGraph = z.infer<typeof WorkspaceGraphSchema>;

// layers.json beside a package's package.json: the layers its modules sit in, lowest first. A module may import its own
// layer and any below it; an import reaching higher is a finding, and so is a cycle between units of one layer.
export const PackageLayerSchema = z.object({
    name: z.string().min(1).describe("The layer's name."),
    about: z.string().optional().describe("What sits in it, in a sentence."),
    units: z
        .array(z.string().min(1))
        .describe(
            "Path prefixes under the root it holds: a directory, a subdirectory, or a module named without its extension. A file belongs to the layer whose unit matches it longest.",
        ),
});
export type PackageLayer = z.infer<typeof PackageLayerSchema>;
export const PackageLayersFileSchema = z.object({
    root: z.string().optional().describe('The directory the units are relative to, from the package. Default "src".'),
    shelves: z.array(z.string()).optional().describe("Top-level directories whose every subdirectory is a unit of its own, such as one per feature."),
    surface: z
        .array(z.string())
        .optional()
        .describe('File-name patterns, `*` a wildcard, of modules that sit above every layer, such as "*.routes.ts". Nothing below may import one.'),
    layers: z.array(PackageLayerSchema).min(1).describe("The layers, lowest first."),
});
export type PackageLayersFile = z.infer<typeof PackageLayersFileSchema>;

export const PackageModulesParamSchema = z.object({
    repo: z.string().describe("Which repository."),
    package: z.string().min(1).describe("Which of its workspace packages, by the name it declares."),
});
export const PackageUnitSchema = z.object({
    id: z
        .string()
        .describe(
            'The unit: a directory under the root, a shelf\'s subdirectory ("features/chat"), a unit layers.json names, "(surface)" for every surface module, or "(root)" for the modules directly in the root, which no rule judges.',
        ),
    modules: z.number().int().nonnegative().describe("How many source modules it holds."),
    layer: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("The declared layer it sits in, by index, lowest 0. Absent when the package declares no layers, or none places it."),
    surface: z.literal(true).optional().describe("The surface modules' unit, above every layer."),
});
export type PackageUnit = z.infer<typeof PackageUnitSchema>;
export const PackageUnitEdgeSchema = z.object({
    from: z.string().describe("The importing unit."),
    to: z.string().describe("The unit it imports."),
    imports: z.number().int().positive().describe("How many value imports make the edge."),
    sites: z.array(z.string()).describe("Up to five of them, as `path:line` relative to the root."),
});
export type PackageUnitEdge = z.infer<typeof PackageUnitEdgeSchema>;
export const PackageModulesSchema = z.object({
    package: z.string().describe("The package."),
    root: z.string().describe("The directory read, relative to the repository."),
    layers: z
        .array(PackageLayerSchema.pick({ name: true, about: true }))
        .optional()
        .describe("Its declared layers, lowest first. Absent when it has no layers.json."),
    invalid: z.string().optional().describe("Why its layers.json could not be read, when it has one that does not parse."),
    units: z.array(PackageUnitSchema).describe("Every unit with a module in it."),
    edges: z
        .array(PackageUnitEdgeSchema)
        .describe("Value imports between units: type-only imports erase and tests import their subject, so neither counts."),
});
export type PackageModules = z.infer<typeof PackageModulesSchema>;
