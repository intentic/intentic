import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    type HeavyCommandOverrides,
    type HeavyCommands,
    type HeavyCommandSettings,
    type HeavyCommandRule,
    type HeavyMatch,
    matchInvocation,
    mergeHeavyRules,
    overridesOf,
    QUEUE_SKIPPED_EXIT_CODE,
} from "@intentic/constants/heavy-rules";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { z } from "zod";
import { drop, isJsonObject, transform } from "../../store/evolution/conversions.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";
import type { ManifestProblem } from "../../store/manifest-problems.js";
import { stateRelPath } from "../../state-paths.js";
import { priorityOf } from "../../workload/workload-class.js";

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
    // Removes the shipped rule of this id.
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
    // The shipped table with the file's overrides on top; the shipped table alone when the file is absent or invalid.
    readonly read: () => Promise<HeavyCommands>;
}

// A rule whose pattern does not compile is reported where it came from and matches nothing.
const reportBadPatterns = (config: HeavyCommands, report: (problem: ManifestProblem) => void): void => {
    matchInvocation("", config, (detail) => report({ kind: "invalidEntry", detail }));
};

export const fileHeavyCommandsStore = (path: string, onInvalid?: (detail: string) => void): HeavyCommandsStore => {
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
    return { read: async () => mergeHeavyRules(await file.read()) };
};

// The wrappers for heavy programs that are not node scripts (bin/heavy-shims in the image).
export const HEAVY_SHIMS_DIR = "/opt/sandbox/heavy-shims";
const HEAVY_HOOK = fileURLToPath(import.meta.resolve("@intentic/constants/heavy-hook"));
const HEAVY_EXEC = fileURLToPath(import.meta.resolve("@intentic/constants/heavy-exec"));

export interface HeavyEnvOptions {
    // Whether matching programs queue (bin/queue-run); false still classes them.
    readonly queueRun: string | undefined;
    // offload-run and which rules' programs it takes to a runner; nothing for a line that must stay here.
    readonly offloadRun?: string | undefined;
    readonly offload?: Readonly<Record<string, string>>;
}

/**
 * The environment, as an `env NAME=value … ` prefix for a shell command (so it may follow exec-ing wrappers like nice or
 * nsenter), under which every program the line starts is judged as it starts: node programs through the hook in
 * NODE_OPTIONS, the rest through the wrappers first on PATH. A heavy one takes the toolchain class, and queues or goes to
 * a runner as the table says.
 */
export const heavyEnvPrefix = (config: HeavyCommands, options: HeavyEnvOptions): string => {
    const toolchain = priorityOf({ class: "toolchain" });
    const spec = {
        rules: config,
        queue: config.queue && options.queueRun !== undefined,
        ...(options.queueRun === undefined ? {} : { queueRun: options.queueRun }),
        ...(options.offloadRun === undefined || options.offload === undefined ? {} : { offloadRun: options.offloadRun, offload: options.offload }),
        klass: toolchain,
    };
    const shims = existsSync(HEAVY_SHIMS_DIR) ? `PATH=${HEAVY_SHIMS_DIR}:"$PATH" INTENTIC_HEAVY_EXEC=${shellQuote(HEAVY_EXEC)} ` : "";
    return `env INTENTIC_HEAVY=${shellQuote(JSON.stringify(spec))} NODE_OPTIONS="--require ${HEAVY_HOOK} \${NODE_OPTIONS:-}" ${shims}`;
};
