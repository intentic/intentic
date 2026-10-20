import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { AgentHarnessSchema, AgentProviderSchema } from "@intentic/sandbox-contract/schemas/agent";
import { SubagentVerificationSchema } from "@intentic/sandbox-contract/schemas/terminal";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDirectory } from "../../store/open-document.js";
import { opt } from "../../opt.js";
import type { ChildSpawnSpec } from "./children.js";

/* WHAT A PARENT SUPERVISES ITS SPAWNED CHILDREN BY, ACROSS A RESTART. A child's record (children.ts) and its roster row
   (subagents.ts) lived in this process's memory, so a restart left every parent unable to reach its children: `send`,
   `answer` and `cancel` answered "No such child", a resumed child turn was never adopted, and a parked `wait` answered
   unknown-target while the child kept working. Each child is written down here as it starts, moves and settles, one file
   apiece, and the next boot reads them back before any interrupted turn resumes (child-restore.ts, spawnedChildrenInFlight). */

const RehomeSchema = z.object({
    provider: AgentProviderSchema,
    model: z.string().min(1),
    harness: AgentHarnessSchema.optional(),
    effort: z.string().optional(),
});

// The spawn as the parent asked for it, with the routing the record resolved: what every later turn of it runs as.
const ChildSpecSchema = z.object({
    prompt: z.string(),
    description: z.string().optional(),
    provider: AgentProviderSchema,
    model: z.string().min(1),
    harness: AgentHarnessSchema.optional(),
    effort: z.string().optional(),
    thinking: z.boolean().optional(),
    fast: z.boolean().optional(),
    account: z.string().optional(),
    on: z.string().optional(),
    fallbacks: z.array(RehomeSchema).optional(),
    // The JSON Schema its result must match (child-result.ts), where the parent asked for one.
    result: z.object({ schema: z.record(z.string(), z.json()) }).optional(),
    // The workflow run it works for (script-runs.ts), whose endings it reads.
    run: z.object({ id: z.string() }).optional(),
});
type ChildSpecOnFile = z.infer<typeof ChildSpecSchema>;

// How its last turn ended, as its roster row said it.
const ChildEndingSchema = z.object({
    status: z.enum(["completed", "failed", "killed"]),
    at: z.number(),
    summary: z.string().optional(),
    error: z.string().optional(),
    verification: SubagentVerificationSchema.optional(),
});

const SpawnedChildSchema = z.object({
    // The conversation that spawned it, the only one that may reach it.
    parent: z.string(),
    spec: ChildSpecSchema,
    depth: z.number().int().min(1),
    // The parent turn's working tree, as its roster handle saw it.
    cwd: z.string(),
    // What a follow-up resumes, as its last turn reported it.
    sessionId: z.string().optional(),
    startedAt: z.number(),
    // `running` while a turn of it is under way, `paused` while its turn waits on a re-run the sandbox booked, `settled`
    // once its last turn ended: what the next boot looks for, since a running one's turn may or may not come back.
    state: z.enum(["running", "paused", "settled", "held"]),
    // A start accepted before it could run, with its original place in the waiting order.
    startHold: z.object({ kind: z.enum(["seat", "lane", "start"]), order: z.number(), reason: z.string().optional(), requestId: z.string().optional() }).optional(),
    ending: ChildEndingSchema.optional(),
    // On `paused`, the wall its turn stopped at.
    pausedOn: z.string().optional(),
    // Its last turn's closing message, cut where a wait cuts it anyway.
    report: z.string().optional(),
    // Turns of it its parent paid a seat for, which a restart counts back into the parent's lifetime budget.
    turns: z.number().int().min(0),
    // What its last turn handed back against `spec.result`: the value, or why there was none.
    result: z.union([z.object({ value: z.json() }), z.object({ error: z.string() })]).optional(),
    // When this was last written.
    at: z.number(),
});
export type SpawnedChild = z.infer<typeof SpawnedChildSchema>;

/** A spawn as its file holds it: every knob only where the spawn named one. */
export const specOnFile = (spec: ChildSpawnSpec): ChildSpecOnFile => {
    const onFile: ChildSpecOnFile = { prompt: spec.prompt, provider: spec.provider, model: spec.model };
    Object.assign(
        onFile,
        opt("description", spec.description),
        opt("harness", spec.harness),
        opt("effort", spec.effort),
        opt("thinking", spec.thinking),
        opt("fast", spec.fast),
        opt("account", spec.account),
        opt("on", spec.on),
        opt("result", spec.result),
        opt("run", spec.run),
        opt("fallbacks", spec.fallbacks?.map((fallback) => ({ ...fallback }))),
    );
    return onFile;
};

/** The spawn its file brings back, in the shape the record holds it. */
export const specFromFile = (onFile: ChildSpecOnFile): ChildSpawnSpec => ({
    prompt: onFile.prompt,
    provider: onFile.provider,
    model: onFile.model,
    ...opt("description", onFile.description),
    ...opt("harness", onFile.harness),
    ...opt("effort", onFile.effort),
    ...opt("thinking", onFile.thinking),
    ...opt("fast", onFile.fast),
    ...opt("account", onFile.account),
    ...opt("on", onFile.on),
    ...opt("result", onFile.result === undefined ? undefined : { schema: onFile.result.schema }),
    ...opt("run", onFile.run),
    ...opt(
        "fallbacks",
        onFile.fallbacks?.map((fallback) => ({
            provider: fallback.provider,
            model: fallback.model,
            ...opt("harness", fallback.harness),
            ...opt("effort", fallback.effort),
        })),
    ),
});

export const spawnedChildrenDocument = defineDocument({ root: "history", path: "spawned-children/", directory: true, schema: SpawnedChildSchema });

// The longest report kept on file: what a wait hands over whole before it points at a retrieval handle.
export const KEPT_REPORT_CHARS = 12_000;

// How long a settled child stays on file after its last turn ended: long enough for a parent to come back to it after a
// weekend, short enough that the directory stays a list of work in hand rather than a history.
export const SETTLED_KEPT_MS = 14 * 24 * 3_600_000;

export interface SpawnedChildren {
    // Neither write throws: each runs off a child's start, move or ending, which must not fail with it. A write
    // replaces the child's file whole, and writes to one child land in the order they were made.
    readonly write: (childId: string, child: SpawnedChild) => void;
    readonly forget: (childId: string) => void;
    readonly list: () => Promise<readonly (SpawnedChild & { readonly id: string })[]>;
}

// One handle per history root, so every caller shares its write order.
const OPENED = new Map<string, SpawnedChildren>();

export const spawnedChildren = (historyRoot: string, logger: Pick<Logger, "warn">): SpawnedChildren => {
    const known = OPENED.get(historyRoot);
    if (known !== undefined) {
        return known;
    }
    const files = openDirectory(spawnedChildrenDocument, join(historyRoot, spawnedChildrenDocument.path));
    // Each child's writes chained, so a settle written after a start never lands under it.
    const chains = new Map<string, Promise<void>>();
    const chained = (childId: string, work: () => Promise<void>, failing: string): void => {
        const before = chains.get(childId) ?? Promise.resolve();
        const run = async (): Promise<void> => {
            await before;
            try {
                await work();
            } catch (error) {
                logger.warn({ err: error, child: childId }, failing);
            }
        };
        const next = run();
        chains.set(childId, next);
        void next.then(() => {
            if (chains.get(childId) === next) {
                chains.delete(childId);
            }
        });
    };
    const opened: SpawnedChildren = {
        write: (childId, child) => {
            const kept: SpawnedChild = { ...child };
            if (kept.report !== undefined) {
                kept.report = kept.report.slice(0, KEPT_REPORT_CHARS);
            }
            chained(
                childId,
                () => files.write(childId, kept),
                "subagents: a child could not be written down, a restart before its next move leaves its parent unable to reach it",
            );
        },
        forget: (childId) =>
            chained(
                childId,
                async () => {
                    await files.remove(childId);
                },
                "subagents: a child that left could not be struck off, the next boot drops it",
            ),
        list: async () => {
            await Promise.all(chains.values());
            const { entries, invalid } = await files.list();
            if (invalid.length > 0) {
                logger.warn({ files: invalid }, "subagents: spawned children this build cannot read, their parents cannot reach them after this restart");
            }
            return entries;
        },
    };
    OPENED.set(historyRoot, opened);
    return opened;
};

// What the boot does with one child on file: bring it back, or strike it off and why.
export type RestoredFate = { readonly kind: "restore" } | { readonly kind: "drop"; readonly why: string };

// What the boot reads of the two conversations, now.
export interface RestoredFacts {
    // Undefined once the child's conversation is gone; `parent` is who spawned it, per the registry.
    readonly child: { readonly parent: string | undefined } | undefined;
    // Undefined once the parent's conversation is gone.
    readonly parent: { readonly archived: boolean } | undefined;
}

/**
 * The boot's decision for one child on file. A child whose first turn never opened its conversation has no registry entry
 * yet, so a missing child conversation is dropped only once the parent is gone too; a child the registry says another
 * conversation started is not this parent's to supervise.
 */
export const restoredFate = (child: SpawnedChild, facts: RestoredFacts, now: number): RestoredFate => {
    if (facts.parent === undefined) {
        return { kind: "drop", why: "the parent's conversation is gone" };
    }
    if (facts.parent.archived) {
        return { kind: "drop", why: "the parent is archived" };
    }
    if (facts.child === undefined && child.turns > 0) {
        return { kind: "drop", why: "the child's conversation is gone" };
    }
    if (facts.child?.parent !== undefined && facts.child.parent !== child.parent) {
        return { kind: "drop", why: "the registry names another parent" };
    }
    if (child.state === "settled" && now - (child.ending?.at ?? child.at) > SETTLED_KEPT_MS) {
        return { kind: "drop", why: "it settled long ago" };
    }
    return { kind: "restore" };
};
