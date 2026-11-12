import { CONVERSATION_BUNDLE_KIND, type ConversationBundle, DIAGNOSTICS_MAX_MINUTES } from "@intentic/sandbox-contract/schemas/diagnostics";
import type { SystemPromptDisclosure } from "@intentic/sandbox-contract/schemas/system-prompt";
import type { Services } from "../../composition.js";
import { runDiagnosticsQuery } from "../../logs/diagnostics-queries.js";
import { opt } from "../../opt.js";
import { version } from "../../version.js";
import type { PersistedAgent } from "../registry/agents-store.js";
import { type FleetRecallDeps, fleetRecall } from "./fleet-recall.js";
import { fleetRows } from "./fleet-transcript.js";

// ONE CONVERSATION'S DEBUG BUNDLE (schemas/diagnostics.ts): what someone without access to this sandbox needs to look into
// what happened to it, in one file. Each part is an answer this sandbox already gives its own agents (`agents show`, its
// record as stored, the diagnostics queries about it), so the bundle shows nothing an agent here could not read, and
// secrets ride in it as their `{{secret:name}}` references, as the record stores them.

// The record's rows kept, newest last, and the most of it a bundle carries: a long conversation's tool output runs to tens
// of megabytes, and the rows that matter to a bug are almost always the last ones.
const TRANSCRIPT_ROWS = 2_000;
const TRANSCRIPT_BYTES = 4_000_000;
// How far past its last activity the browser's reports are read: a page that broke on what the turn left behind
// reports it after the turn ended.
const AFTER_MS = 30 * 60_000;

/** Reads what a conversation's last turn was told, as GET /agents/{id}/system-prompt answers it. */
export type BundlePromptReader = (id: string) => Promise<SystemPromptDisclosure | undefined>;

export type BundleDeps = FleetRecallDeps &
    Pick<Services, "usage" | "info" | "promptRecord" | "logger"> & {
        readonly historyRoot: string;
        // The base prompt's own text is filled in by the agent subsystem (withBaseText), which this one may not import:
        // a route module hands the reader in, and without one the prompt rides as recorded, its sections whole.
        readonly readPrompt?: BundlePromptReader;
    };

// What the conversation's last turn was told before its own words: the environment it worked in, which the record never
// carries. A bundle without it still says everything else, so a failed read leaves it out.
const promptOf = async (deps: BundleDeps, id: string): Promise<SystemPromptDisclosure | undefined> => {
    try {
        return await (deps.readPrompt ?? deps.promptRecord.of)(id);
    } catch (error) {
        deps.logger.warn({ err: error, conversationId: id }, "bundle: the conversation's system prompt could not be read");
        return undefined;
    }
};

// The newest rows that fit the byte budget, oldest first.
const keptRows = <Row>(rows: readonly Row[]): readonly Row[] => {
    let bytes = 0;
    let from = rows.length;
    while (from > 0) {
        const size = JSON.stringify(rows[from - 1]).length;
        if (bytes + size > TRANSCRIPT_BYTES) {
            break;
        }
        bytes += size;
        from -= 1;
    }
    return rows.slice(from);
};

// Minutes back from now to a moment, within what the diagnostics may reach.
const minutesSince = (now: number, at: number): number => Math.min(DIAGNOSTICS_MAX_MINUTES, Math.max(1, Math.ceil((now - at) / 60_000)));

/** One conversation's bundle, as GET /fleet/{handle}/bundle answers it. */
export const conversationBundle = async (deps: BundleDeps, entry: PersistedAgent, now: number = Date.now()): Promise<ConversationBundle> => {
    const id = entry.id;
    const records = { historyRoot: deps.historyRoot, usage: deps.usage, now: () => now };
    const lastActive = Math.max(entry.updatedAt, entry.answeredAt ?? 0);
    const [agent, record, prompt, timeline, turns, errors, restarts, browser] = await Promise.all([
        fleetRecall(deps, entry, deps.historyRoot),
        fleetRows(deps, entry, { last: TRANSCRIPT_ROWS }),
        promptOf(deps, id),
        runDiagnosticsQuery(records, { query: "timeline", conversationId: id, limit: 200 }),
        runDiagnosticsQuery(records, { query: "turns", conversationId: id, limit: 100 }),
        runDiagnosticsQuery(records, { query: "errors", contains: id, level: "warn", stacks: true, group: false, limit: 60 }),
        runDiagnosticsQuery(records, { query: "restarts", sinceMinutes: minutesSince(now, entry.createdAt), limit: 40 }),
        runDiagnosticsQuery(records, {
            query: "errors",
            source: "browser",
            from: new Date(entry.createdAt).toISOString(),
            until: new Date(Math.min(now, lastActive + AFTER_MS)).toISOString(),
            limit: 60,
        }),
    ]);
    const kept = keptRows(record.rows);
    // Rows of the record the bundle does not carry, the oldest ones: past the row count, or past the byte budget.
    const omitted = record.total - kept.length;
    return {
        kind: CONVERSATION_BUNDLE_KIND,
        version: 1,
        exportedAt: new Date(now).toISOString(),
        sandbox: { name: deps.info?.name ?? "this sandbox", ...opt("version", deps.info?.version ?? version) },
        conversation: id,
        show: { agent },
        transcript: { total: record.total, rows: kept, ...opt("omitted", omitted > 0 ? omitted : undefined) },
        ...opt("prompt", prompt),
        timeline,
        turns,
        errors,
        restarts,
        browser,
    };
};
