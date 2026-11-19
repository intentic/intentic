import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode, errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { type HeavyClass, memoryMibOf, scriptPathOf, SHIPPED_HEAVY_COMMANDS } from "@intentic/constants/heavy-rules";
import { HEAVY_CLASSES_FILE } from "@intentic/sandbox-contract/schemas/run-targets";
import { z } from "zod";
import { discoverRepos, repoDirOf, ROOT_REPO } from "../layout/repo-discovery.js";

/* A REPOSITORY'S OWN HEAVY COMMANDS: `<repo>/.intentic/heavy.json`, `{ "classes": [ … ] }`, each class a script or a
   command the project knows is heavy, what it holds, and how it shares the sandbox (heavy-rules.cjs classRules turns
   each into a rule of the one heavy-command table, judged as the program starts like every other).

   (2026-11-19, the shinobi-society audit) That project kept its half-hour motion captures apart with a lock inside its
   capture script and "one at a time, nothing else heavy beside a capture" in its AGENTS.md, and agents added `flock`,
   `nice` and `-j 1` by hand around it. Declared here, the queue every conversation's builds take enforces it instead.
   It lives in the repository, beside `run.json` and `checks.json`, rather than in the sandbox's own
   `heavy-commands.json` (in its config folder): what a project's script costs and whether it must run alone is a fact about
   the project, true in every sandbox that clones it, and it changes with the script in the same commit. The owner's
   file still tunes it: a class's id is a rule id there (`ruleEdits`, to change a field or disable it).

   Read from the workspace's main tree, the root repository's and every discovered one's, the first class of an id
   winning; a class that does not parse is named and left out, and the rest of its file still counts. */

// How long the list of repositories is kept before it is walked again: the read runs before every agent command.
const REPOS_TTL_MS = 60_000;

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const NAME_RULE = "lowercase letters, digits and dashes";

const HeavyClassSchema = z
    .object({
        id: z.string().regex(NAME, NAME_RULE),
        scripts: z.array(z.string().refine((path) => scriptPathOf(path) !== undefined, "a path inside the repository, relative to its root")).optional(),
        commands: z.array(z.string().trim().min(1)).optional(),
        memory: z
            .union([z.string(), z.number()])
            .transform(String)
            .refine((size) => memoryMibOf(size) !== undefined, "a size such as 6G or 512M")
            .optional(),
        cpus: z.number().int().positive().max(4096).optional(),
        pin: z.boolean().optional(),
        limit: z.number().int().positive().optional(),
        group: z.string().regex(NAME, NAME_RULE).optional(),
        exclusive: z.boolean().optional(),
        quiet: z.boolean().optional(),
        maxHoldSeconds: z.number().int().nonnegative().optional(),
        onDeadline: z.enum(["run", "skip"]).optional(),
    })
    .strict()
    .refine((entry) => (entry.scripts?.length ?? 0) + (entry.commands?.length ?? 0) > 0, "it names no script and no command");

// Each class is parsed on its own, so one mistake costs that class and not the file.
const HeavyClassesFileSchema = z.object({ classes: z.array(z.unknown()) });

export interface DeclaredClasses {
    readonly classes: HeavyClass[];
    // One sentence per file or class left out, naming where it is.
    readonly problems: string[];
}

const SHIPPED_IDS = new Set(SHIPPED_HEAVY_COMMANDS.rules.map((rule) => rule.id));

// One repository's file as classes, and what in it was left out.
const parseFile = (text: string, where: string): DeclaredClasses => {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        return { classes: [], problems: [`${where}: not JSON (${errorMessage(error)})`] };
    }
    const file = HeavyClassesFileSchema.safeParse(raw);
    if (!file.success) {
        return { classes: [], problems: [`${where}: expected { "classes": [ … ] }`] };
    }
    const classes: HeavyClass[] = [];
    const problems: string[] = [];
    file.data.classes.forEach((entry, index) => {
        const parsed = HeavyClassSchema.safeParse(entry);
        if (!parsed.success) {
            problems.push(`${where} classes[${index}]: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "class"}: ${issue.message}`).join("; ")}`);
        } else if (SHIPPED_IDS.has(parsed.data.id)) {
            problems.push(`${where} classes[${index}]: "${parsed.data.id}" is a built-in rule's id; name the class something else`);
        } else {
            classes.push(parsed.data);
        }
    });
    return { classes, problems };
};

/** The classes the given repositories declare, in that order, the first class of an id winning. */
export const readHeavyClasses = async (root: string, repos: readonly string[]): Promise<DeclaredClasses> => {
    const files = await Promise.all(
        repos.map(async (repo) => {
            const where = repo === ROOT_REPO ? HEAVY_CLASSES_FILE : `${repo}/${HEAVY_CLASSES_FILE}`;
            try {
                const text = await readFile(join(repoDirOf(root, repo), HEAVY_CLASSES_FILE), "utf8").catch(undefinedIfMissing);
                return text === undefined ? { classes: [], problems: [] } : parseFile(text, where);
            } catch (error) {
                return { classes: [], problems: [`${where}: could not be read (${errnoCode(error) ?? errorMessage(error)})`] };
            }
        }),
    );
    const seen = new Set<string>();
    const classes: HeavyClass[] = [];
    const problems = files.flatMap((file) => file.problems);
    for (const entry of files.flatMap((file) => file.classes)) {
        if (seen.has(entry.id)) {
            problems.push(`heavy class "${entry.id}" is declared twice; the first declaration is used`);
            continue;
        }
        seen.add(entry.id);
        classes.push(entry);
    }
    return { classes, problems };
};

/**
 * The workspace's declared classes, read fresh on each call (the repositories' list kept REPOS_TTL_MS); each problem is
 * told to `onProblem` once, not on every command.
 */
export const workspaceHeavyClasses = (root: string, onProblem: (detail: string) => void, now: () => number = Date.now): (() => Promise<HeavyClass[]>) => {
    let repos: { readonly at: number; readonly list: Promise<string[]> } | undefined;
    const told = new Set<string>();
    return async () => {
        if (repos === undefined || now() - repos.at > REPOS_TTL_MS) {
            repos = { at: now(), list: discoverRepos(root) };
        }
        const { classes, problems } = await readHeavyClasses(root, [ROOT_REPO, ...(await repos.list)]);
        for (const problem of problems.filter((entry) => !told.has(entry))) {
            told.add(problem);
            onProblem(problem);
        }
        return classes;
    };
};
