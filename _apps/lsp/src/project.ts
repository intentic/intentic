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
}

export interface ProjectDeps {
    // file -> monotonic version. Bumping an entry is what tells the language service to re-read that file.
    readonly versions: Map<string, number>;
    readonly registry: ts.DocumentRegistry;
}

export const createProjectDeps = (): ProjectDeps => ({ versions: new Map(), registry: ts.createDocumentRegistry() });

// The nearest tsconfig.json walking up from the file; undefined ⇒ no project (the file compiles on its own).
export const findTsconfig = (fromPath: string): string | undefined => ts.findConfigFile(dirname(fromPath), ts.sys.fileExists, "tsconfig.json");

const parseProject = (tsconfigPath: string | undefined, targetFile: string): { options: ts.CompilerOptions; fileNames: string[] } => {
    if (tsconfigPath === undefined) {
        return { options: { ...ts.getDefaultCompilerOptions(), allowJs: true }, fileNames: [targetFile] };
    }
    const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (read.error !== undefined) {
        throw new Error(`failed to read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`);
    }
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfigPath));
    return { options: parsed.options, fileNames: parsed.fileNames };
};

// Open the project a file belongs to. `targetFile` is always a root so an excluded file (e.g. a test the project
// leaves out) can still be renamed/diagnosed against the rest of the program.
export const openProject = (tsconfigPath: string | undefined, targetFile: string, deps: ProjectDeps = createProjectDeps()): Project => {
    const { options, fileNames } = parseProject(tsconfigPath, targetFile);
    const roots = fileNames.includes(targetFile) ? fileNames : [...fileNames, targetFile];
    // The project's own directory, NOT process.cwd(): a daemon serves projects from many directories at once, and
    // relative paths in compilerOptions (baseUrl, paths, typeRoots) resolve against the tsconfig that declared them.
    const projectDirectory = dirname(tsconfigPath ?? targetFile);
    const host: ts.LanguageServiceHost = {
        getScriptFileNames: () => [...roots],
        getScriptVersion: (fileName) => String(deps.versions.get(fileName) ?? 0),
        getScriptSnapshot: (fileName) => {
            const text = ts.sys.readFile(fileName);
            return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
        },
        getCurrentDirectory: () => projectDirectory,
        getCompilationSettings: () => options,
        getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists,
        getDirectories: ts.sys.getDirectories,
        // realpath is optional on both sides; only forward it when the platform's ts.sys provides one (it drives
        // symlink resolution for pnpm's linked node_modules). exactOptionalPropertyTypes rejects passing undefined.
        ...(ts.sys.realpath !== undefined ? { realpath: ts.sys.realpath } : {}),
    };
    return { service: ts.createLanguageService(host, deps.registry), fileNames: roots };
};
