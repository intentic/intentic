import { join } from "node:path";
import { parseJsonWith } from "@intentic/base/json";
import type { ManifestProblem } from "@intentic/sandbox-contract/schemas/system";
import type { Logger } from "pino";
import { z } from "zod";
import { recordStandingProblem } from "../../../store/manifest/manifest-problems.js";
import { bootHistoryDocument } from "./boot-history.js";

// THIS DAEMON IS THE LAST BUILD THAT BOOTED (2026-11-16). netd starts it in place of the compiled trees mounted from a
// checkout when that build failed STRIKES times in a row before it was ready (netd/crates/netd/src/fallback.rs), and
// tells it so in this variable. netd has already written the rollback into netd-kills.jsonl, which the restart record's
// post-mortem tells; this puts it on the owner's settings-problems card, beside a restart storm, for the life of the run.
const ROLLED_BACK_ENV = "INTENTIC_ROLLED_BACK";

const BuildSchema = z.object({ hash: z.string(), builtAt: z.number() });
export const RolledBackSchema = z.object({
    at: z.number(),
    from: BuildSchema,
    to: BuildSchema,
    failures: z.number(),
    error: z.string().optional(),
    step: z.string().optional(),
});
export type RolledBack = z.infer<typeof RolledBackSchema>;

// Read when this module loads, before the netd door forgets the daemon-only variables (daemon-env.ts).
const told = process.env[ROLLED_BACK_ENV];

/** What netd said, when this daemon runs the kept build; undefined otherwise or when it cannot be read. */
export const rolledBackOf = (raw: string | undefined): RolledBack | undefined => {
    if (raw === undefined || raw === "") {
        return undefined;
    }
    return parseJsonWith(raw, RolledBackSchema);
};

const builtAt = (at: number): string => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");

// The first line of the boot error netd carried over: its message, without the stack.
const firstLine = (error: string | undefined): string | undefined => error?.split("\n")[0]?.trim() || undefined;

/** The owner's card for a boot on the kept build. */
export const rolledBackProblem = (rolled: RolledBack): ManifestProblem => {
    const error = firstLine(rolled.error);
    return {
        kind: "invalidEntry",
        detail:
            `The sandbox is running the last daemon build that booted (built ${builtAt(rolled.to.builtAt)}), because the build installed after it ` +
            `(built ${builtAt(rolled.from.builtAt)}) failed ${String(rolled.failures)} times before it was ready${ 
            error === undefined ? "" : `${rolled.step === undefined ? "" : ` at "${rolled.step}"`}: ${error}`}`,
        fix: "Fix the build and rebuild or restart the sandbox: the next start tries the new build first, and comes back here only if it fails the same way.",
    };
};

/** The rollback's sentence for the restart record (post-mortem.ts). */
export const rolledBackText = (from: { readonly hash: string }, failures: number, error: string | undefined): string => {
    const said = firstLine(error);
    return `netd started the last build that booted after build ${from.hash} failed ${String(failures)} times before it was ready${said === undefined ? "" : ` (${said})`}`;
};

/** Says so in the log and on the owner's card when this daemon is the kept build. */
export const reportRolledBack = (historyRoot: string, logger: Logger, raw: string | undefined = told): void => {
    const rolled = rolledBackOf(raw);
    if (rolled === undefined) {
        return;
    }
    logger.error(
        { from: rolled.from, to: rolled.to, failures: rolled.failures, error: firstLine(rolled.error), step: rolled.step },
        "boot: running the last build that booted, because the installed build failed before it was ready",
    );
    recordStandingProblem(join(historyRoot, bootHistoryDocument.path), rolledBackProblem(rolled));
};
