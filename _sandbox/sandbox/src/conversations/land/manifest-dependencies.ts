import { parse as parseToml } from "smol-toml";
import { z } from "zod";

// The dependency names a manifest declares, for the review's "adds dependencies" line (agent-changes.ts). Names only,
// never versions: the question a review asks is what the project takes on, and a bump of something already there is
// not that. Node reads package.json; Python reads pyproject.toml's [project] lists and requirements files.

const PACKAGE_JSON = /(^|\/)package\.json$/;
const PYPROJECT = /(^|\/)pyproject\.toml$/;
// requirements.txt and its usual siblings (requirements-dev.txt, requirements_test.txt).
const REQUIREMENTS = /(^|\/)requirements[\w.-]*\.txt$/;

export const isManifest = (path: string): boolean => PACKAGE_JSON.test(path) || PYPROJECT.test(path) || REQUIREMENTS.test(path);

// Every block npm, pnpm and yarn install from, name to version range. Anything else in the file is not read.
const DeclaredBlockSchema = z.record(z.string(), z.string()).optional();
const PackageJsonSchema = z.object({
    dependencies: DeclaredBlockSchema,
    devDependencies: DeclaredBlockSchema,
    optionalDependencies: DeclaredBlockSchema,
    peerDependencies: DeclaredBlockSchema,
});

// PEP 621's two lists of PEP 508 requirement strings; a file with no [project] table declares nothing here.
const PyprojectSchema = z.object({
    project: z
        .object({
            dependencies: z.array(z.string()).optional(),
            "optional-dependencies": z.record(z.string(), z.array(z.string())).optional(),
        })
        .optional(),
});

// What the schema reads in the text, undefined when the text is no document of that format or the schema refuses it.
const parsedWith = <T>(schema: z.ZodType<T>, format: "json" | "toml", text: string): T | undefined => {
    try {
        return schema.safeParse(format === "json" ? JSON.parse(text) : parseToml(text)).data;
        // allow(silent-catch): Malformed JSON or TOML declares no dependencies this review can trust.
    } catch {
        // Not JSON or TOML at all: a manifest mid-edit, which declares nothing this review can stand behind.
        return undefined;
    }
};

const nodeDependencies = (text: string): Map<string, string> | undefined => {
    const manifest = parsedWith(PackageJsonSchema, "json", text);
    if (manifest === undefined) {
        return undefined;
    }
    const { dependencies, devDependencies, optionalDependencies, peerDependencies } = manifest;
    const names = [dependencies, devDependencies, optionalDependencies, peerDependencies].flatMap((block) => Object.keys(block ?? {}));
    return new Map(names.map((name) => [name, name]));
};

// A PEP 508 requirement's name, followed by what may come after one (extras, a version, a marker, a URL) or nothing.
// Anchored on that follower so `git+https://…` or `./local` is not read as a package called `git` or nothing at all.
const REQUIREMENT_NAME = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:$|[[(<>=!~;@])/;

// PEP 503: `Foo_Bar`, `foo.bar` and `foo-bar` are one package, so they compare as one.
const normalizedPython = (name: string): string => name.toLowerCase().replaceAll(/[-_.]+/g, "-");

const pythonDependencies = (requirements: readonly string[]): Map<string, string> => {
    const names = new Map<string, string>();
    for (const requirement of requirements) {
        const name = REQUIREMENT_NAME.exec(requirement.trim())?.[1];
        if (name !== undefined) {
            names.set(normalizedPython(name), name);
        }
    }
    return names;
};

const requirementsDependencies = (text: string): Map<string, string> =>
    pythonDependencies(
        text
            .split(/\r?\n/)
            .map((line) => line.replace(/(^|\s)#.*$/, "").trim())
            // An option line (-r, -e, --index-url, a --hash continuation) names no package of its own.
            .filter((line) => line !== "" && !line.startsWith("-")),
    );

const pyprojectDependencies = (text: string): Map<string, string> | undefined => {
    const document = parsedWith(PyprojectSchema, "toml", text);
    if (document === undefined) {
        return undefined;
    }
    const project = document.project;
    return pythonDependencies([...(project?.dependencies ?? []), ...Object.values(project?.["optional-dependencies"] ?? {}).flat()]);
};

// What `text` declares, keyed the way its ecosystem compares names and valued as the manifest spells them. Undefined
// when it cannot be read as that manifest, which is not a claim that it declares nothing.
export const declaredDependencies = (path: string, text: string): ReadonlyMap<string, string> | undefined => {
    if (PACKAGE_JSON.test(path)) {
        return nodeDependencies(text);
    }
    if (PYPROJECT.test(path)) {
        return pyprojectDependencies(text);
    }
    return REQUIREMENTS.test(path) ? requirementsDependencies(text) : undefined;
};

// The names `after` declares that `before` did not, as `after` spells them, in the order of their keys, so Python's
// casing does not reorder the list. Keys are unique, so no two compare equal.
export const addedNames = (before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] =>
    [...after]
        .filter(([key]) => !before.has(key))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([, name]) => name);
