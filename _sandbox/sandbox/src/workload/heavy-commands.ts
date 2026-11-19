import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    type HeavyClass,
    type HeavyCommandOverrides,
    type HeavyCommands,
    type HeavyCommandSettings,
    type HeavyCommandRule,
    type HeavyMatch,
    heavyWords,
    matchInvocation,
    mergeHeavyRules,
    overridesOf,
    QUEUE_SKIPPED_EXIT_CODE,
} from "@intentic/constants/heavy-rules";
import { errorMessage } from "@intentic/base/errors";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { z } from "zod";
import { drop, isJsonObject, transform } from "../store/evolution/conversions.js";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";
import type { ManifestProblem } from "../store/manifest/manifest-problems.js";
import { stateRelPath } from "../state-paths.js";
import { priorityOf } from "./workload-class.js";

// The agent's Bash hook wrapper for heavy commands (heavy-commands.json); holds a slot so concurrent test fan-outs take
// turns. Not used by terminal-run.ts's runner, which is single user-triggered ops, not repeated builds.
export const QUEUE_RUN_BIN = "/usr/local/bin/queue-run";

// Off when the wrapper isn't baked in or the operator opts out; the caller that builds the agent's hooks checks this,
// same fail-open shape as tmuxRunEnabled.
export const queueRunEnabled = (): boolean => process.env["INTENTIC_AGENT_QUEUE"] !== "0" && existsSync(QUEUE_RUN_BIN);

// Which programs are heavy enough to take turns: the shipped table (@intentic/constants/heavy-rules, which the scripts
// read too) with the owner's overrides on top. A program is judged as it starts, by what it is and the arguments it got
// (heavy-hook.cjs for node programs, the wrappers in bin/heavy-shims for the rest), never by the words of the line that
// started it; this module only hands that table down, in the environment of the lines the daemon runs.

export { QUEUE_SKIPPED_EXIT_CODE, type HeavyCommands, type HeavyMatch };

const OnDeadlineSchema = z.enum(["run", "skip"]);

const RuleEditSchema = z.object({
    // A shipped rule's id changes that rule; any other id is the owner's own rule and needs a pattern.
    id: z.string().min(1),
    // JS regex source (no delimiters/flags), case-insensitive, matched against `<program> <args…>`.
    pattern: z.string().min(1).optional(),
    pool: z.string().min(1).optional(),
    limit: z.number().int().positive().optional(),
    maxHoldSeconds: z.number().int().nonnegative().optional(),
    exempt: z.boolean().optional(),
    onDeadline: OnDeadlineSchema.optional(),
    // A regex the program's working directory must match too.
    cwd: z.string().min(1).optional(),
    // The memory gate's price by name (@intentic/constants/memory-room SIZE_BYTES); a name it does not know is the class's.
    size: z.string().min(1).optional(),
    // Judged even under a program that already holds a slot (heavy-rules.cjs judgedUnder).
    nests: z.boolean().optional(),
    // Nothing else heavy beside it; also wait for a calm machine and report (bin/quiet); the cores it keeps busy, and
    // whether it is pinned to them (heavy-launch.cjs). What a repository's `.intentic/heavy.json` class says, for a rule
    // of the owner's own or any rule by id.
    exclusive: z.boolean().optional(),
    quiet: z.boolean().optional(),
    cpus: z.number().int().positive().optional(),
    pin: z.boolean().optional(),
    // Removes the shipped rule (or the declared class) of this id.
    disabled: z.boolean().optional(),
});

// Only what the owner changed: every field absent is the shipped value, so a fix that ships reaches every sandbox.
export const HeavyCommandOverridesSchema = z.object({
    limit: z.number().int().positive().optional(),
    defaultPool: z.string().min(1).optional(),
    waitSeconds: z.number().int().nonnegative().optional(),
    memoryGateSeconds: z.number().int().nonnegative().optional(),
    maxHoldSeconds: z.number().int().nonnegative().optional(),
    onDeadline: OnDeadlineSchema.optional(),
    // False stops queueing heavy programs; they keep their rank for the OOM killer either way.
    queue: z.boolean().optional(),
    ruleEdits: z.array(RuleEditSchema).optional(),
});

// Until 2026-09-25 the file held the whole table, seeded once from the shipped rules and never again, so a fix to a
// shipped rule never reached a sandbox that already had the file. Converted into overrides: what equals a rule some
// release shipped goes, and an empty rule list, which switched the queue off, becomes `queue: false`.
const isFullTable = (value: z.infer<typeof OldTableSchema> | Record<string, unknown>): value is z.infer<typeof OldTableSchema> =>
    OldTableSchema.safeParse(value).success;
const OldTableSchema = z.object({ rules: z.array(z.object({ id: z.string(), pattern: z.string() }).passthrough()) }).passthrough();

export const heavyCommandsDocument = defineDocument({
    path: stateRelPath(".intentic/config/heavy-commands.json"),
    schema: HeavyCommandOverridesSchema,
    history: [
        transform(
            "keeps only what the owner changed from the shipped heavy-command rules",
            (value): value is Partial<HeavyCommandSettings> & { rules: HeavyCommandRule[] } => isJsonObject(value) && isFullTable(value),
            (value) => overridesOf(value) as Record<string, never>,
        ),
        // The whole-table key, retired with the shape: no later version may read `rules` another way.
        drop("rules"),
    ],
});

export interface HeavyCommandsStore {
    // The shipped table with the repositories' declared classes and the file's overrides on top; the shipped table alone
    // when the file is absent or invalid and nothing is declared.
    readonly read: () => Promise<HeavyCommands>;
}

// A rule whose pattern does not compile is reported where it came from and matches nothing.
const reportBadPatterns = (config: HeavyCommands, report: (problem: ManifestProblem) => void): void => {
    matchInvocation("", config, (detail) => report({ kind: "invalidEntry", detail }));
};

// `classes` is what the workspace's repositories declare in their `.intentic/heavy.json` (workspace/deps/heavy-classes.ts),
// read with the file on every read, so a commit that changes a declaration binds the next command.
export const fileHeavyCommandsStore = (
    path: string,
    onInvalid?: (detail: string) => void,
    classes?: () => Promise<readonly HeavyClass[]>,
): HeavyCommandsStore => {
    const file = openDocument<typeof heavyCommandsDocument, HeavyCommandOverrides>(heavyCommandsDocument, path, {
        // A file the schema refuses reads as no overrides, named to `onInvalid`, rather than as unreadable: the built-in
        // rules stand either way.
        lenient: (raw, report) => {
            const parsed = HeavyCommandOverridesSchema.safeParse(raw);
            if (parsed.success) {
                reportBadPatterns(mergeHeavyRules(parsed.data), report);
                return parsed.data;
            }
            onInvalid?.(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
            return {};
        },
        fallback: () => ({}),
    });
    // A declaration that cannot be read costs its own classes, never the shipped table.
    const declared = async (): Promise<readonly HeavyClass[]> => {
        try {
            return (await classes?.()) ?? [];
        } catch (error) {
            onInvalid?.(`declared heavy classes: ${errorMessage(error)}`);
            return [];
        }
    };
    return { read: async () => mergeHeavyRules(await file.read(), await declared()) };
};

// The wrappers for heavy programs that are not node scripts (bin/heavy-shims in the image).
export const HEAVY_SHIMS_DIR = "/opt/sandbox/heavy-shims";
// The interpreters' wrappers (python3, bash, sh, uv, make), ahead of the rest only while a repository declares a class:
// they catch `python3 scripts/capture.py` by its script, and nothing at all for a sandbox that declares none.
export const INTERPRETER_SHIMS_DIR = `${HEAVY_SHIMS_DIR}/interpreters`;
const HEAVY_HOOK = fileURLToPath(import.meta.resolve("@intentic/constants/heavy-hook"));
const HEAVY_EXEC = fileURLToPath(import.meta.resolve("@intentic/constants/heavy-exec"));

export interface HeavyEnvOptions {
    // Whether matching programs queue (bin/queue-run); false still classes them.
    readonly queueRun: string | undefined;
    // offload-run and which rules' programs it takes to a runner; nothing for a line that must stay here.
    readonly offloadRun?: string | undefined;
    readonly offload?: Readonly<Record<string, string>>;
}

// What a heavy program is judged by as it starts, one spec for the shell-line prefix and the process environment alike.
const heavySpec = (config: HeavyCommands, options: HeavyEnvOptions) => ({
    rules: config,
    queue: config.queue && options.queueRun !== undefined,
    ...(options.queueRun === undefined ? {} : { queueRun: options.queueRun }),
    ...(options.offloadRun === undefined || options.offload === undefined ? {} : { offloadRun: options.offloadRun, offload: options.offload }),
    klass: priorityOf({ class: "toolchain" }),
});

/**
 * The environment, as an `env NAME=value … ` prefix for a shell command (so it may follow exec-ing wrappers like nice or
 * nsenter), under which every program the line starts is judged as it starts: node programs through the hook in
 * NODE_OPTIONS, the rest through the wrappers first on PATH. A heavy one takes the toolchain class, and queues or goes to
 * a runner as the table says.
 */
export const heavyEnvPrefix = (config: HeavyCommands, options: HeavyEnvOptions): string => {
    const words = interpreterWords(config);
    const dirs = words === undefined ? HEAVY_SHIMS_DIR : `${INTERPRETER_SHIMS_DIR}:${HEAVY_SHIMS_DIR}`;
    const declared = words === undefined ? "" : `INTENTIC_HEAVY_WORDS=${shellQuote(words)} `;
    const shims = existsSync(HEAVY_SHIMS_DIR) ? `PATH=${dirs}:"$PATH" INTENTIC_HEAVY_EXEC=${shellQuote(HEAVY_EXEC)} ${declared}` : "";
    return `env INTENTIC_HEAVY=${shellQuote(JSON.stringify(heavySpec(config, options)))} NODE_OPTIONS="--require ${HEAVY_HOOK} \${NODE_OPTIONS:-}" ${shims}`;
};

// What the interpreters' wrappers look for (heavy-rules.cjs heavyWords), `:`-joined; undefined when no repository
// declares a class or the image has no wrappers for them, and then they stay off the PATH.
const interpreterWords = (config: HeavyCommands): string | undefined => {
    const words = heavyWords(config);
    return words.length === 0 || !existsSync(INTERPRETER_SHIMS_DIR) ? undefined : words.join(":");
};

/**
 * The same environment as variables, for a runtime whose shell the daemon never writes a line for (Codex's app-server,
 * Cursor's session): set once for the turn, it judges every program that shell starts exactly as a Claude Code turn's
 * line does, so an install takes the one install lane whichever runtime ran it. `inherited` is the environment the
 * variables extend; its PATH and NODE_OPTIONS are kept behind the wrappers.
 */
export const heavyEnvVariables = (config: HeavyCommands, options: HeavyEnvOptions, inherited: Readonly<Record<string, string | undefined>>): Record<string, string> => {
    const nodeOptions = inherited["NODE_OPTIONS"];
    const path = inherited["PATH"];
    const words = interpreterWords(config);
    const dirs = words === undefined ? HEAVY_SHIMS_DIR : `${INTERPRETER_SHIMS_DIR}:${HEAVY_SHIMS_DIR}`;
    const judged = {
        INTENTIC_HEAVY: JSON.stringify(heavySpec(config, options)),
        NODE_OPTIONS: nodeOptions === undefined || nodeOptions === "" ? `--require ${HEAVY_HOOK}` : `--require ${HEAVY_HOOK} ${nodeOptions}`,
    };
    if (!existsSync(HEAVY_SHIMS_DIR)) {
        return judged;
    }
    const wrapped = { ...judged, PATH: path === undefined || path === "" ? dirs : `${dirs}:${path}`, INTENTIC_HEAVY_EXEC: HEAVY_EXEC };
    return words === undefined ? wrapped : { ...wrapped, INTENTIC_HEAVY_WORDS: words };
};
