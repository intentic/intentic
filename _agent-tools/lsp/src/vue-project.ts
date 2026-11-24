import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

// A Vue package as its own typecheck sees it: the package whose `vue-tsc` checks a file, the tsconfig that script names,
// and that tsconfig's files and path aliases as the package's own TypeScript parses them. The native compiler `lsp diag`
// runs for plain TypeScript cannot read a `.vue` file, so these packages are checked with their own `vue-tsc` instead
// (vue-check.ts), over the files a change reaches rather than all of them.

export interface VuePackage {
    readonly dir: string;
    // The package.json name, for the command a fallback names (`pnpm --filter <name> typecheck`).
    readonly name: string;
    // The tsconfig the package's `typecheck` script hands `vue-tsc -p`, absolute.
    readonly tsconfig: string;
    readonly vueTsc: string;
    readonly typescript: string;
}

export interface VueProject {
    readonly pkg: VuePackage;
    // Every file the package's typecheck compiles, absolute.
    readonly files: readonly string[];
    // The ambient declarations among them, which every scoped check loads too.
    readonly ambient: readonly string[];
    readonly paths: Readonly<Record<string, readonly string[]>>;
    // What `paths` targets are relative to.
    readonly pathsBase: string;
}

// What the API's diagnostics carry as their text: a string, or a chain of them.
interface MessageChain {
    readonly messageText: string;
    readonly next?: readonly MessageChain[];
}
type DiagnosticMessage = string | MessageChain;

// The config host the parser asks for: the API's own `sys`, plus where a fatal config error goes.
interface ConfigHost {
    readonly onUnRecoverableConfigFileDiagnostic: (diagnostic: { readonly messageText: DiagnosticMessage }) => void;
}

// Options laid over the file's own; none here.
type NoOptions = Readonly<Record<string, never>>;

// The slice of the TypeScript API this reads, from whichever version the package installs.
interface TypeScriptApi {
    readonly sys: object;
    readonly ScriptKind: { readonly Deferred: number };
    readonly getParsedCommandLineOfConfigFile: (
        path: string,
        options: NoOptions,
        host: ConfigHost,
        extendedCache?: undefined,
        watchOptions?: undefined,
        extraFileExtensions?: readonly { extension: string; isMixedContent: boolean; scriptKind: number }[],
    ) =>
        | {
              readonly fileNames: readonly string[];
              readonly options: { readonly paths?: Record<string, string[]>; readonly pathsBasePath?: string; readonly baseUrl?: string };
              readonly errors: readonly { readonly messageText: DiagnosticMessage }[];
          }
        | undefined;
    readonly preProcessFile: (text: string, readImports: boolean, detectJs: boolean) => { readonly importedFiles: readonly { readonly fileName: string }[] };
    readonly flattenDiagnosticMessageText: (message: DiagnosticMessage, newLine: string) => string;
}

interface Manifest {
    readonly name?: string;
    readonly scripts?: Record<string, string>;
    readonly dependencies?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
}

const readManifest = (path: string): Manifest | undefined => {
    if (!existsSync(path)) {
        return undefined;
    }
    try {
        // SAFETY: a package.json is a JSON object; the fields read are each checked for their type where used.
        return JSON.parse(readFileSync(path, "utf8")) as Manifest;
    } catch {
        // allow(silent-catch): a manifest that does not parse names no package, and the walk goes on above it
        return undefined;
    }
};

// The nearest package.json above a file, with its directory.
const owningPackage = (file: string): { readonly dir: string; readonly manifest: Manifest } | undefined => {
    for (let dir = dirname(resolve(file)); ; ) {
        const manifest = readManifest(join(dir, "package.json"));
        if (manifest !== undefined) {
            return { dir, manifest };
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
};

// The project `vue-tsc` is pointed at in a typecheck script: its `-p`/`--project` value, else the package's tsconfig.json.
export const projectOfScript = (script: string | undefined): string => {
    const words = (script ?? "").split(/\s+/u);
    const at = words.findIndex((word) => /(^|\/)vue-tsc(\.js)?$/u.test(word));
    if (at !== -1) {
        for (let index = at + 1; index < words.length && !/^(&&|\|\||;|\|)$/u.test(words[index] ?? ""); index += 1) {
            const word = words[index] ?? "";
            if (word === "-p" || word === "--project") {
                return words[index + 1] ?? "tsconfig.json";
            }
            const joined = /^--project=(.+)$/u.exec(word);
            if (joined?.[1] !== undefined) {
                return joined[1];
            }
        }
    }
    return "tsconfig.json";
};

const resolveFrom = (dir: string, request: string): string | undefined => {
    try {
        return createRequire(join(dir, "package.json")).resolve(request);
    } catch {
        // allow(silent-catch): not resolvable from the package is exactly "not installed there"
        return undefined;
    }
};

/** The Vue package that owns `file`: one whose manifest depends on `vue-tsc` and has it installed; undefined otherwise. */
export const vuePackageOf = (file: string): VuePackage | undefined => {
    const owner = owningPackage(file);
    if (owner === undefined) {
        return undefined;
    }
    const { dir, manifest } = owner;
    const declared = manifest.devDependencies?.["vue-tsc"] ?? manifest.dependencies?.["vue-tsc"];
    if (declared === undefined) {
        return undefined;
    }
    const vueTscManifest = resolveFrom(dir, "vue-tsc/package.json");
    const typescript = resolveFrom(dir, "typescript");
    if (vueTscManifest === undefined || typescript === undefined) {
        return undefined;
    }
    const vueTsc = join(dirname(vueTscManifest), "bin", "vue-tsc.js");
    const tsconfig = resolve(dir, projectOfScript(manifest.scripts?.["typecheck"]));
    if (!existsSync(vueTsc) || !existsSync(tsconfig)) {
        return undefined;
    }
    return { dir, name: manifest.name ?? dir, tsconfig, vueTsc, typescript };
};

const apis = new Map<string, TypeScriptApi>();
export const typescriptOf = (pkg: VuePackage): TypeScriptApi => {
    let api = apis.get(pkg.typescript);
    if (api === undefined) {
        // SAFETY: `typescript` resolved from the package is the TypeScript compiler API, of which this reads the slice
        // TypeScriptApi names, present in every release since 4.x.
        api = createRequire(import.meta.url)(pkg.typescript) as TypeScriptApi;
        apis.set(pkg.typescript, api);
    }
    return api;
};

/** The package's project as its own TypeScript parses its tsconfig, `.vue` files included; throws with the parser's words. */
export const loadVueProject = (pkg: VuePackage): VueProject => {
    const ts = typescriptOf(pkg);
    const problems: string[] = [];
    // ts.sys is the ParseConfigFileHost the API expects, less the one member supplied here.
    const host: ConfigHost = {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => void problems.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    };
    const parsed = ts.getParsedCommandLineOfConfigFile(pkg.tsconfig, {}, host, undefined, undefined, [
        { extension: ".vue", isMixedContent: true, scriptKind: ts.ScriptKind.Deferred },
    ]);
    if (parsed === undefined) {
        throw new Error(`${pkg.tsconfig} does not parse: ${problems.join("; ")}`);
    }
    const files = parsed.fileNames.map((file) => resolve(file));
    return {
        pkg,
        files,
        ambient: files.filter((file) => file.endsWith(".d.ts")),
        paths: parsed.options.paths ?? {},
        pathsBase: parsed.options.pathsBasePath ?? parsed.options.baseUrl ?? dirname(pkg.tsconfig),
    };
};
