import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode, isMissing } from "@intentic/base/errors";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { parse as parseToml, TomlError } from "smol-toml";
import { z } from "zod";

/* WHAT START RUNS FOR A REPOSITORY, decided from the repository's own files. The first match wins:
   1. a Procfile at its root: all of its entries, the way foreman runs one (procfileCommand)
   2. operator/package.json's `dev` script: a panel kept beside the repository's code
   3. the root package.json's `dev` script, else its `start`
   4. a Cargo.toml with exactly one binary cargo can pick: `cargo run`, with `-p` or `--bin` where cargo needs telling
   The panels list's `hasPanel`, `installed` and `start` facts and the start route all read this one answer, so a
   repository offered Start always has something to start. What the run turns out to be (a server on a port, a window on
   the sandbox desktop, output in its terminal) is observed once it runs, never declared here. */

export type RunSource = "procfile" | "operator" | "dev" | "start" | "cargo";

export interface RunPlan {
    readonly source: RunSource;
    // Where the command runs.
    readonly cwd: string;
    // What a person would type, as the editor shows it: `pnpm dev`, `cargo run -p game`, a Procfile's entry names.
    readonly shown: string;
    // What is typed into the panel's terminal: the command, with an install in front of it where one is needed.
    readonly command: string;
    // Whether a start takes seconds rather than an install or a first build first: node_modules for a Node run, target/
    // for a Cargo one.
    readonly installed: boolean;
}

// No `exec`: the interactive shell stays, so Ctrl+C and re-running with ↑ still work through install-then-run.
const NODE_INSTALL = "test -d node_modules || pnpm install && ";

// A path that is not there, or that has a file where a directory was expected on the way to it: nothing to read.
const NOT_A_DIRECTORY = "ENOTDIR";

// A text file's contents, or undefined when it is not there; any other failed read is not an answer and is thrown.
const textOf = async (path: string): Promise<string | undefined> => {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if (isMissing(error) || errnoCode(error) === NOT_A_DIRECTORY) {
            return undefined;
        }
        throw error;
    }
};

/* ---- Procfile ---------------------------------------------------------------------------------------------- */

export interface ProcfileEntry {
    readonly name: string;
    readonly command: string;
}

// `name: command` per line, as Heroku and foreman read it. Blank lines and `#` comments match nothing; a repeated name
// keeps its first command.
export const parseProcfile = (text: string): ProcfileEntry[] => {
    const entries: ProcfileEntry[] = [];
    for (const line of text.split(/\r?\n/)) {
        const entry = /^([A-Za-z0-9_-]+):\s*(\S.*)$/.exec(line.trim());
        const name = entry?.[1];
        const command = entry?.[2];
        if (name !== undefined && command !== undefined && !entries.some((known) => known.name === name)) {
            entries.push({ name, command: command.trim() });
        }
    }
    return entries;
};

// The entry the panel's port is for: `web`, Heroku's name for the one process taking requests, else the first.
const portEntry = (entries: readonly [ProcfileEntry, ...ProcfileEntry[]]): ProcfileEntry =>
    entries.find((entry) => entry.name === "web") ?? entries[0];

/**
 * The command a Procfile runs as. One entry is its own command. Several run together under one bash: the port's entry
 * in the foreground, where the terminal's keys reach it, and the others beside it with PORT unset, so none of them binds
 * the port the preview is routed to. When the foreground one ends, by itself or by Ctrl+C, the trap ends the rest, so the
 * terminal never keeps a worker nobody can see.
 */
export const procfileCommand = (entries: readonly [ProcfileEntry, ...ProcfileEntry[]]): string => {
    const front = portEntry(entries);
    if (entries.length === 1) {
        return front.command;
    }
    const beside = entries.filter((entry) => entry !== front).map((entry) => `(unset PORT; ${entry.command}) &`);
    return `bash -c ${shellQuote(["trap 'trap - TERM; kill 0' INT TERM EXIT;", ...beside, `(${front.command})`].join(" "))}`;
};

const nonEmpty = <T>(items: readonly T[]): items is readonly [T, ...T[]] => items.length > 0;

/* ---- package.json ------------------------------------------------------------------------------------------ */

// Of a manifest, only the two scripts Start can run; anything else in it may be any shape.
const ManifestSchema = z.looseObject({ scripts: z.looseObject({ dev: z.string().optional(), start: z.string().optional() }).optional() });

// Which of `dev` and `start` the directory's package.json names, or undefined with no manifest. One that does not parse,
// or names either as something other than a command, names neither.
const scriptsOf = async (dir: string): Promise<{ readonly dev: boolean; readonly start: boolean } | undefined> => {
    const text = await textOf(join(dir, "package.json"));
    if (text === undefined) {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        if (error instanceof SyntaxError) {
            return { dev: false, start: false };
        }
        throw error;
    }
    const scripts = ManifestSchema.safeParse(parsed).data?.scripts;
    return { dev: scripts?.dev !== undefined, start: scripts?.start !== undefined };
};

const nodePlan = (source: RunSource, cwd: string, script: "dev" | "start"): RunPlan => {
    const shown = `pnpm ${script}`;
    return { source, cwd, shown, command: `${NODE_INSTALL}${shown}`, installed: existsSync(join(cwd, "node_modules")) };
};

/* ---- Cargo.toml -------------------------------------------------------------------------------------------- */

const CargoSchema = z.looseObject({
    package: z
        .looseObject({ name: z.string().optional(), "default-run": z.string().optional(), autobins: z.boolean().optional() })
        .optional(),
    bin: z.array(z.looseObject({ name: z.string().optional() })).optional(),
    workspace: z
        .looseObject({
            members: z.array(z.string()).optional(),
            "default-members": z.array(z.string()).optional(),
            exclude: z.array(z.string()).optional(),
        })
        .optional(),
});
type CargoManifest = z.infer<typeof CargoSchema>;

// A directory's Cargo.toml, or undefined when it has none or one cargo itself would refuse.
const cargoOf = async (dir: string): Promise<CargoManifest | undefined> => {
    const text = await textOf(join(dir, "Cargo.toml"));
    if (text === undefined) {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = parseToml(text);
    } catch (error) {
        // A manifest that is not TOML; anything else is a fault of ours and is thrown.
        if (error instanceof TomlError) {
            return undefined;
        }
        throw error;
    }
    return CargoSchema.safeParse(parsed).data;
};

const entriesOf = async (dir: string) => {
    try {
        return await readdir(dir, { withFileTypes: true });
    } catch (error) {
        if (isMissing(error) || errnoCode(error) === NOT_A_DIRECTORY) {
            return [];
        }
        throw error;
    }
};

// The binaries cargo builds for a package: its [[bin]] targets by name, and the ones it finds by itself unless autobins
// is off (src/main.rs, named for the package, and each src/bin/<name>.rs or src/bin/<name>/main.rs).
const binariesOf = async (dir: string, manifest: CargoManifest): Promise<string[]> => {
    const names = new Set(manifest.bin?.flatMap((target) => (target.name === undefined ? [] : [target.name])) ?? []);
    if (manifest.package?.autobins !== false) {
        const own = manifest.package?.name;
        if (own !== undefined && existsSync(join(dir, "src", "main.rs"))) {
            names.add(own);
        }
        for (const entry of await entriesOf(join(dir, "src", "bin"))) {
            if (entry.isFile() && entry.name.endsWith(".rs")) {
                names.add(entry.name.slice(0, -".rs".length));
            } else if (entry.isDirectory() && existsSync(join(dir, "src", "bin", entry.name, "main.rs"))) {
                names.add(entry.name);
            }
        }
    }
    return [...names];
};

// What `cargo run` needs told for this package to know which binary: nothing with a default-run or a single binary, the
// package's own binary out of several, and undefined for a package it cannot pick for (a library, or several binaries
// none of which is named for the package).
const binaryArgs = async (dir: string, manifest: CargoManifest): Promise<string[] | undefined> => {
    if (manifest.package === undefined) {
        return undefined;
    }
    if (manifest.package["default-run"] !== undefined) {
        return [];
    }
    const binaries = await binariesOf(dir, manifest);
    if (binaries.length === 1) {
        return [];
    }
    const own = manifest.package.name;
    return own !== undefined && binaries.includes(own) ? ["--bin", own] : undefined;
};

// A workspace's member directories: each path as written, and `dir/*` as every directory in dir. A pattern with any
// other wildcard is skipped rather than guessed at; `exclude` drops exact paths.
const memberDirs = async (root: string, patterns: readonly string[], exclude: readonly string[]): Promise<string[]> => {
    const excluded = new Set(exclude.map((path) => join(root, path)));
    const dirs: string[] = [];
    for (const pattern of patterns) {
        if (pattern.endsWith("/*") && !pattern.slice(0, -2).includes("*")) {
            const parent = join(root, pattern.slice(0, -2));
            for (const entry of await entriesOf(parent)) {
                if (entry.isDirectory()) {
                    dirs.push(join(parent, entry.name));
                }
            }
        } else if (!/[*?[]/.test(pattern)) {
            dirs.push(join(root, pattern));
        }
    }
    return [...new Set(dirs)].filter((dir) => !excluded.has(dir)).toSorted();
};

// The `cargo run` for a repository: its root package when cargo can pick a binary of it, else the one workspace member
// (of `default-members`, when it names them) that has a binary to run. Several such members is a choice the repository
// has to make itself, with a Procfile.
const cargoCommand = async (repoDir: string): Promise<string | undefined> => {
    const root = await cargoOf(repoDir);
    if (root === undefined) {
        return undefined;
    }
    const own = await binaryArgs(repoDir, root);
    if (own !== undefined) {
        return ["cargo", "run", ...own].join(" ");
    }
    if (root.workspace === undefined) {
        return undefined;
    }
    const patterns = root.workspace["default-members"] ?? root.workspace.members ?? [];
    const runnable: string[] = [];
    for (const dir of await memberDirs(repoDir, patterns, root.workspace.exclude ?? [])) {
        const member = await cargoOf(dir);
        const name = member?.package?.name;
        const args = member === undefined ? undefined : await binaryArgs(dir, member);
        if (name !== undefined && args !== undefined) {
            runnable.push(["cargo", "run", "-p", shellQuote(name), ...args.map(shellQuote)].join(" "));
        }
    }
    return runnable.length === 1 ? runnable[0] : undefined;
};

/* ---- The ladder -------------------------------------------------------------------------------------------- */

const OPERATOR_DIR = "operator";

/** What Start runs for the repository at `repoDir`, or undefined when it has nothing this can tell how to start. */
export const runPlanOf = async (repoDir: string): Promise<RunPlan | undefined> => {
    const procfile = await textOf(join(repoDir, "Procfile"));
    const entries = procfile === undefined ? [] : parseProcfile(procfile);
    if (nonEmpty(entries)) {
        const node = existsSync(join(repoDir, "package.json"));
        const cargo = existsSync(join(repoDir, "Cargo.toml"));
        return {
            source: "procfile",
            cwd: repoDir,
            shown: entries.length === 1 ? entries[0].command : `Procfile: ${entries.map((entry) => entry.name).join(", ")}`,
            command: `${node ? NODE_INSTALL : ""}${procfileCommand(entries)}`,
            installed: node ? existsSync(join(repoDir, "node_modules")) : !cargo || existsSync(join(repoDir, "target")),
        };
    }
    const operator = join(repoDir, OPERATOR_DIR);
    if ((await scriptsOf(operator))?.dev === true) {
        return nodePlan("operator", operator, "dev");
    }
    const scripts = await scriptsOf(repoDir);
    if (scripts?.dev === true) {
        return nodePlan("dev", repoDir, "dev");
    }
    if (scripts?.start === true) {
        return nodePlan("start", repoDir, "start");
    }
    const cargo = await cargoCommand(repoDir);
    if (cargo !== undefined) {
        return { source: "cargo", cwd: repoDir, shown: cargo, command: cargo, installed: existsSync(join(repoDir, "target")) };
    }
    return undefined;
};
