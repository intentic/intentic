import { dirname } from "node:path";
import ts from "typescript";

// A TS LanguageService scoped to one file's tsconfig project. The service backs both verbs: `findRenameLocations`
// for rename and `get*Diagnostics` for diag. Cross-package usages live in other programs (each package is its own
// tsconfig project), so rename updates the invoked file's project — the skill documents that scope.
//
// Everything a project needs to stay WARM across requests is injected rather than owned: the document registry so
// lib.d.ts and shared node_modules types are parsed once for the whole workspace instead of once per project, and
// the version map so a file edited in one project invalidates its snapshot in every project that includes it.
// A cold one-shot caller passes nothing and gets private ones.

export interface Project {
    readonly service: ts.LanguageService;
    readonly fileNames: readonly string[];
    // Why the config chain failed to load, when it did. TypeScript recovers from a failed load by silently
    // dropping to default options (ES5, no lib, no types) — a program that reports Map, Promise and `node:`
    // imports as broken in perfectly healthy code. Carrying the reason instead of discarding it is what lets
    // every caller refuse to answer rather than relay those. undefined ⇒ the config loaded clean.
    readonly configError: string | undefined;
}

export interface ProjectDeps {
    // file -> monotonic version. Bumping an entry is what tells the language service to re-read that file.
    readonly versions: Map<string, number>;
    readonly registry: ts.DocumentRegistry;
}

export const createProjectDeps = (): ProjectDeps => ({ versions: new Map(), registry: ts.createDocumentRegistry() });

// The nearest tsconfig.json walking up from the file; undefined ⇒ no project (the file compiles on its own).
export const findTsconfig = (fromPath: string): string | undefined => ts.findConfigFile(dirname(fromPath), ts.sys.fileExists, "tsconfig.json");

// The parse errors that mean the config CHAIN did not load: an `extends` target or listed file that could not be
// found (6053) or read (5083). These are the errors TypeScript recovers from by falling back to defaults, which
// is exactly the recovery a diagnostics tool must not accept. Other parse errors (an unknown option, an empty
// include) leave the loaded options intact and the program's answers meaningful.
const UNLOADED_CONFIG = new Set([5083, 6053]);

const parseProject = (
    tsconfigPath: string | undefined,
    targetFile: string,
): { options: ts.CompilerOptions; fileNames: string[]; configError: string | undefined } => {
    if (tsconfigPath === undefined) {
        return { options: { ...ts.getDefaultCompilerOptions(), allowJs: true }, fileNames: [targetFile], configError: undefined };
    }
    const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (read.error !== undefined) {
        return { options: {}, fileNames: [], configError: `${tsconfigPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}` };
    }
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfigPath));
    const fatal = parsed.errors.find((error) => error.category === ts.DiagnosticCategory.Error && UNLOADED_CONFIG.has(error.code));
    return {
        options: parsed.options,
        fileNames: parsed.fileNames,
        configError: fatal === undefined ? undefined : `${tsconfigPath}: ${ts.flattenDiagnosticMessageText(fatal.messageText, "\n")}`,
    };
};

/* .vue imports are the Vue toolchain's to resolve (vue-tsc/Volar), not this service's — without help every one
 * of them reports TS2307 on a healthy file, permanently, in any project that uses SFCs. The wildcard shim makes
 * them resolve as `any` instead: those imports go UNCHECKED here rather than falsely broken, and every other
 * diagnostic in the file stays real. Virtual — served from memory by the host — so it exists in every project
 * without writing into anyone's tree, and inert in projects that never import a .vue file. */
const VUE_SHIM = "/__lsp-virtual/vue-shim.d.ts";
const VUE_SHIM_TEXT = 'declare module "*.vue" {\n    const component: any;\n    export default component;\n}\n';

// Global diagnostics that mean the program's FOUNDATIONS failed to resolve: a `types` entry with no type
// definition file behind it (2688), or the global types and values every file leans on (2318, 2468). They indict
// the environment the checker stands in, not the code, and every per-file diagnostic computed on top of them is
// an artifact of the blindness.
const UNLOADED_FOUNDATIONS = new Set([2318, 2468, 2688]);

// Why this project's answers cannot be vouched for, or undefined when they can. Checked before every answer:
// diagnostics from a half-loaded program are confident, specific and wrong — worse than silence, because the
// reader spends real reasoning deciding to distrust them.
export const unusableReason = (project: Project): string | undefined => {
    if (project.configError !== undefined) {
        return project.configError;
    }
    const blind = project.service
        .getCompilerOptionsDiagnostics()
        .find((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error && UNLOADED_FOUNDATIONS.has(diagnostic.code));
    return blind === undefined ? undefined : ts.flattenDiagnosticMessageText(blind.messageText, "\n");
};

// Open the project a file belongs to. `targetFile` is always a root so an excluded file (e.g. a test the project
// leaves out) can still be renamed/diagnosed against the rest of the program.
export const openProject = (tsconfigPath: string | undefined, targetFile: string, deps: ProjectDeps = createProjectDeps()): Project => {
    const { options, fileNames, configError } = parseProject(tsconfigPath, targetFile);
    const roots = fileNames.includes(targetFile) ? fileNames : [...fileNames, targetFile];
    // The project's own directory, NOT process.cwd(): a daemon serves projects from many directories at once, and
    // relative paths in compilerOptions (baseUrl, paths, typeRoots) resolve against the tsconfig that declared them.
    const projectDirectory = dirname(tsconfigPath ?? targetFile);
    const host: ts.LanguageServiceHost = {
        getScriptFileNames: () => [...roots, VUE_SHIM],
        getScriptVersion: (fileName) => String(deps.versions.get(fileName) ?? 0),
        getScriptSnapshot: (fileName) => {
            if (fileName === VUE_SHIM) {
                return ts.ScriptSnapshot.fromString(VUE_SHIM_TEXT);
            }
            const text = ts.sys.readFile(fileName);
            return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
        },
        getCurrentDirectory: () => projectDirectory,
        getCompilationSettings: () => options,
        getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
        fileExists: (fileName) => fileName === VUE_SHIM || ts.sys.fileExists(fileName),
        readFile: (fileName) => (fileName === VUE_SHIM ? VUE_SHIM_TEXT : ts.sys.readFile(fileName)),
        readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists,
        getDirectories: ts.sys.getDirectories,
        // realpath is optional on both sides; only forward it when the platform's ts.sys provides one (it drives
        // symlink resolution for pnpm's linked node_modules). exactOptionalPropertyTypes rejects passing undefined.
        ...(ts.sys.realpath !== undefined ? { realpath: ts.sys.realpath } : {}),
    };
    return { service: ts.createLanguageService(host, deps.registry), fileNames: roots, configError };
};
