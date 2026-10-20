import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentHarnessSchema, AgentProviderSchema } from "@intentic/sandbox-contract/schemas/agent";
import type { Services } from "../../../composition.js";
import { canonicalJson } from "../../../audit/audit-chain.js";
import { opt } from "../../../opt.js";
import { type ResultSchema, ResultSchemaSchema, type ResultValue, resultSchemaFault } from "../child-result.js";
import { type ChildParent, childReportOf, sendToChild, spawnChild } from "../children.js";
import { type ChildSettlement, childResultOf, childSettlementOf, onChildSettled } from "../child-records.js";
import { type Cache, keepRun, type LiveRun, type ScriptCall, type ScriptDefaults } from "./script-run-store.js";

// One agent() call of a workflow run (script-runs.ts): what it asks, read and keyed; handed back from the cache where the
// same asking already finished; else a spawned child doing it, waited on to its ending, and sent back to fix a result
// that does not match its schema.

const RehomeSchema = z.object({ provider: AgentProviderSchema, model: z.string().min(1) });

// What one agent() call may say beside its prompt.
const AgentOptionsSchema = z.object({
    label: z.string().max(120).optional(),
    phase: z.string().max(120).optional(),
    provider: AgentProviderSchema.optional(),
    model: z.string().min(1).optional(),
    harness: AgentHarnessSchema.optional(),
    effort: z.string().optional(),
    schema: ResultSchemaSchema.optional(),
    fallbacks: z.array(RehomeSchema).max(4).optional(),
});
type AgentOptions = z.infer<typeof AgentOptionsSchema>;

// How many calls one run may make.
export const MAX_CALLS = 200;
// How many times a worker whose result does not match its schema is sent back to fix it.
const MAX_REPAIRS = 2;

// The calls waiting on a worker's ending, by the worker's id.
const WAITING = new Map<string, (settlement: ChildSettlement) => void>();
let listening: (() => void) | undefined;

const listen = (): void => {
    listening ??= onChildSettled((childId, settlement) => {
        const waiter = WAITING.get(childId);
        if (waiter !== undefined) {
            WAITING.delete(childId);
            waiter(settlement);
        }
    });
};


/** Stops waiting on a worker whose call nobody reads any more. */
export const forgetWorker = (childId: string): void => void WAITING.delete(childId);

/** For a suite: no call waits on any worker. */
export const resetCallsForTest = (): void => WAITING.clear();

/** What a call is known by: what it asks, as the run will run it. */
export const callKey = (prompt: string, route: ResultValue): string => createHash("sha256").update(canonicalJson({ prompt, route })).digest("hex");

// A worker's ending as the call it serves reads it: now, if it already settled, else when it does.
const settlementOf = (services: Services, childId: string): Promise<ChildSettlement> =>
    new Promise((resolveSettled) => {
        listen();
        WAITING.set(childId, resolveSettled);
        const already = childSettlementOf(services.conversations, childId);
        if (already !== undefined) {
            WAITING.delete(childId);
            resolveSettled(already);
        }
    });

// One worker at a time per free place: at most `size` calls of the run have a worker at once.
// The places a run's workers take: one each, handed back as the call ends.
export interface Places {
    // Resolves once a place is free, with the call that gives it back.
    readonly take: () => Promise<() => void>;
}

export const placesFor = (size: number): Places => {
    let free = size;
    const queue: (() => void)[] = [];
    const release = (): void => {
        const next = queue.shift();
        if (next === undefined) {
            free += 1;
            return;
        }
        next();
    };
    return {
        take: () =>
            new Promise((granted) => {
                if (free > 0) {
                    free -= 1;
                    granted(release);
                    return;
                }
                queue.push(() => granted(release));
            }),
    };
};

// What a worker is told on top of its task when its result did not match.
const repairWords = (error: string): string =>
    `Your parent's workflow could not use your result: ${error} Call the \`result\` tool again with a value that matches the schema in your task, then end your turn with a short report.`;

// What a call answers the script, once its worker has ended: its value, or why there is none, as the script's error.
const answerOf = async (
    services: Services,
    parent: ChildParent,
    call: ScriptCall,
    schema: ResultSchema | undefined,
    settlement: ChildSettlement,
): Promise<{ readonly value: ResultValue } | { readonly error: string } | { readonly again: true }> => {
    const child = call.child ?? "";
    if (settlement.status !== "completed") {
        return { error: `${call.label}: ${settlement.error ?? `its worker ${settlement.status === "killed" ? "was stopped" : "failed"}`}` };
    }
    if (schema === undefined) {
        return { value: childReportOf(services.conversations, child) ?? settlement.report };
    }
    const result = childResultOf(services.conversations, child);
    if (result !== undefined && "value" in result) {
        return { value: result.value };
    }
    const why = result?.error ?? "It handed back no result.";
    if (call.repairs >= MAX_REPAIRS) {
        return { error: `${call.label}: no result matching its schema after ${MAX_REPAIRS} corrections. ${why}` };
    }
    call.repairs += 1;
    const sent = await sendToChild(services, parent, child, repairWords(why));
    return sent.ok ? { again: true } : { error: `${call.label}: its result did not match, and it could not be asked again: ${sent.message}` };
};

export interface RunContext {
    readonly services: Services;
    readonly live: LiveRun;
    readonly parent: ChildParent;
    readonly cache: Cache;
    readonly places: Places;
    readonly asked: Map<string, number>;
}

// The provider, model and the rest a call runs on, and the shape of what it hands back: what its key is made of.
const routeOf = (options: AgentOptions, defaults: ScriptDefaults | undefined): { readonly route: ScriptDefaults; readonly schema: ResultSchema | undefined } | { readonly fault: string } => {
    const provider = options.provider ?? defaults?.provider;
    const model = options.model ?? (options.provider === undefined ? defaults?.model : undefined);
    if (provider === undefined || model === undefined) {
        return { fault: "agent() needs a provider and a model: name them in its options, or give the run its defaults." };
    }
    const fault = options.schema === undefined ? undefined : resultSchemaFault(options.schema);
    if (fault !== undefined) {
        return { fault };
    }
    const harness = options.harness ?? (options.provider === undefined ? defaults?.harness : undefined);
    const effort = options.effort ?? (options.provider === undefined ? defaults?.effort : undefined);
    return { route: { provider, model, ...opt("harness", harness), ...opt("effort", effort) }, schema: options.schema };
};

// A worker started, or one this run already had, waited on until its call has an answer.
const workCall = async (context: RunContext, call: ScriptCall, prompt: string, options: AgentOptions, route: ScriptDefaults, schema: ResultSchema | undefined): Promise<ResultValue> => {
    const { services, live, parent } = context;
    if (call.child === undefined) {
        const spawned = await spawnChild(services, parent, {
            prompt,
            description: `${live.record.name}: ${call.label}`.slice(0, 200),
            provider: route.provider,
            model: route.model,
            ...opt("harness", route.harness),
            ...opt("effort", route.effort),
            ...opt("fallbacks", options.fallbacks),
            ...opt("result", schema === undefined ? undefined : { schema }),
            run: { id: live.id },
        });
        if (!spawned.ok) {
            throw new Error(`${call.label}: ${spawned.message}`);
        }
        call.child = spawned.id;
        keepRun(services, live);
    }
    for (;;) {
        const settlement = await settlementOf(services, call.child);
        const answer = await answerOf(services, parent, call, schema, settlement);
        if ("again" in answer) {
            keepRun(services, live);
            continue;
        }
        if ("error" in answer) {
            call.state = "failed";
            call.error = answer.error;
            keepRun(services, live);
            throw new Error(answer.error);
        }
        call.state = "done";
        call.value = answer.value;
        keepRun(services, live);
        return answer.value;
    }
};

// One agent() call as the run knows it: what it asks, what it is called, and which asking of the same it is.
interface AskedCall {
    readonly key: string;
    readonly occurrence: number;
    readonly label: string;
    readonly options: AgentOptions;
    readonly route: ScriptDefaults;
    readonly schema: ResultSchema | undefined;
}

// The call the script made, read: its options checked, its route settled, its key and its count taken.
const askedCall = (context: RunContext, prompt: string, raw: ResultValue): AskedCall => {
    const parsed = AgentOptionsSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(`agent()'s options do not read: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    }
    const options = parsed.data;
    const routed = routeOf(options, context.live.record.defaults);
    if ("fault" in routed) {
        throw new Error(routed.fault);
    }
    const { provider, model, harness, effort } = routed.route;
    const key = callKey(prompt, { provider, model, harness: harness ?? null, effort: effort ?? null, schema: routed.schema ?? null });
    const occurrence = context.asked.get(key) ?? 0;
    context.asked.set(key, occurrence + 1);
    const label = options.label ?? (prompt.replaceAll(/\s+/gu, " ").trim().slice(0, 60) || "agent");
    return { key, occurrence, label, options, route: routed.route, schema: routed.schema };
};

// What the call answers without a worker: this run's own finished call (a restart re-ran the script), or an earlier run's
// for the same asking (a resume), filed as handed back. Undefined where it needs one.
const answeredBefore = (context: RunContext, asked: AskedCall, known: ScriptCall | undefined): { readonly value: ResultValue } | undefined => {
    if (known?.state === "done") {
        return { value: known.value ?? null };
    }
    const cached = context.cache.get(`${asked.key}#${asked.occurrence}`);
    if (known !== undefined || cached === undefined) {
        return undefined;
    }
    const { live } = context;
    live.record.calls.push({
        key: asked.key,
        occurrence: asked.occurrence,
        label: asked.label,
        ...opt("phase", asked.options.phase ?? live.record.phase),
        state: "done",
        cached: true,
        value: cached.value ?? null,
        repairs: 0,
    });
    keepRun(context.services, live);
    return { value: cached.value ?? null };
};

// One agent() call: handed back from the cache, waited on where this run's worker already has it, or started.
export const agentCall = async (context: RunContext, prompt: string, raw: ResultValue): Promise<ResultValue> => {
    const { live } = context;
    const asked = askedCall(context, prompt, raw);
    const known = live.record.calls.find((call) => call.key === asked.key && call.occurrence === asked.occurrence);
    const before = answeredBefore(context, asked, known);
    if (before !== undefined) {
        return before.value;
    }
    if (known === undefined && live.record.calls.length >= MAX_CALLS) {
        throw new Error(`This workflow has made ${MAX_CALLS} agent calls, the most one run may make.`);
    }
    const call: ScriptCall = known ?? {
        key: asked.key,
        occurrence: asked.occurrence,
        label: asked.label,
        ...opt("phase", asked.options.phase ?? live.record.phase),
        state: "running",
        repairs: 0,
    };
    if (known === undefined) {
        live.record.calls.push(call);
    }
    call.state = "running";
    const release = await context.places.take();
    try {
        return await workCall(context, call, prompt, asked.options, asked.route, asked.schema);
    } finally {
        release();
    }
};

