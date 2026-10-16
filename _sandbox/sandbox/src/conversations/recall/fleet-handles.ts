import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { z } from "zod";
import type { Services } from "../../composition.js";
import { statePath } from "../../state-paths.js";
import { type FleetRecallDeps, type HandleResolution, present, resolveHandle } from "./fleet-recall.js";
import { parseJsonOr } from "@intentic/base/json";

// The handles `resolveHandle` cannot answer from the registry alone, because they name something a conversation HAD
// rather than something it is: a runtime session it has since retired, a run or turn of it, an in-process subagent one
// of its turns started. Each is a lookup in a record the daemon already keeps (the activity log, the phrase index, the
// Claude runtime's own session store), tried only when the registry had no answer and only for a handle shaped like
// what it looks for, so an ordinary miss costs nothing. Agents met these ids in logs, terminal names and tool output
// and got "No conversation answers to" for every one of them.

export type FleetHandleDeps = FleetRecallDeps & Pick<Services, "activity" | "config" | "logger">;

// A session id as the shell meets it: whole, or its first eight hex digits.
const SESSION = /^[0-9a-f]{8}(?:-[0-9a-f-]+)?$/u;
// A whole UUID: a run, a turn, or a session.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
// The Claude runtime's id for an in-process subagent (its Agent tool's `agentId`).
const SUBAGENT = /^a[0-9a-f]{16}$/u;

// How many activity entries a lookup reads back, newest first; the log is pruned to a few megabytes, held in memory.
const ACTIVITY_SCAN = 100_000;
// How much of a session file's head is read for the branch it ran on, which every entry of it carries.
const SESSION_HEAD_BYTES = 256 * 1024;

const found = (deps: FleetRecallDeps, id: string, via: string): HandleResolution | undefined => {
    const entry = deps.agents.entry(id);
    return entry === undefined ? undefined : { kind: "found", entry, via };
};

// Conversations whose turns ran in a session (or a turn) the activity log recorded: every turn writes its session and
// conversation there, so a session the conversation has since retired still names it.
const fromActivity = async (deps: FleetHandleDeps, wanted: string): Promise<HandleResolution | undefined> => {
    const events = await deps.activity.list({ limit: ACTIVITY_SCAN }).catch((error) => {
        deps.logger.warn({ err: error }, "fleet: the activity log could not be read for a handle lookup");
        return [];
    });
    const bySession = new Set<string>();
    const byTurn = new Set<string>();
    for (const event of events) {
        if (event.conversationId === undefined) {
            continue;
        }
        if (event.sessionId?.startsWith(wanted) === true) {
            bySession.add(event.conversationId);
        }
        if (event.turnId === wanted) {
            byTurn.add(event.conversationId);
        }
    }
    const [turn] = [...byTurn];
    if (turn !== undefined) {
        return found(deps, turn, `turn ${wanted} is one of its turns (activity log)`);
    }
    const ids = [...bySession];
    if (ids.length > 1) {
        const candidates = ids.flatMap((id) => deps.agents.entry(id) ?? []);
        return candidates.length > 1 ? { kind: "ambiguous", candidates } : undefined;
    }
    return ids[0] === undefined ? undefined : found(deps, ids[0], `session ${wanted} is one it ran in earlier (activity log)`);
};

// A run id, through the `run <id>` line the phrase index keeps for every run of a record.
const fromRun = async (deps: FleetHandleDeps, wanted: string): Promise<HandleResolution | undefined> => {
    const hits = await deps.saidIndex.search(`run ${wanted}`, "conversation", true, true).catch((error) => {
        deps.logger.warn({ err: error }, "fleet: the phrase index could not be searched for a run id");
        return new Map<string, never>();
    });
    const [id] = [...hits.keys()];
    return id === undefined ? undefined : found(deps, id, `run ${wanted} is one of its runs`);
};

// The Claude runtime's session store shared by every unfenced conversation (sessions/session-store.ts).
const claudeProjects = (deps: FleetHandleDeps): string => join(statePath(deps.config.workspaceRoot, ".intentic/records/sessions/claude/"), "projects");

interface SubagentMeta {
    readonly agentType?: string;
    readonly description?: string;
}

// The two words of the runtime's meta file a sentence names it by; anything else in it, or a file that is not JSON,
// leaves them out rather than failing the lookup.
const SubagentMetaSchema = z.object({ agentType: z.string().optional(), description: z.string().optional() });

const metaOf = (raw: string): SubagentMeta => {
    const parsed = parseJsonOr(raw, undefined);
    if (parsed === undefined) {
        // The runtime's meta file is its own to write; one that is not JSON names nothing, and the lookup goes on without its words.
        return {};
    }
    const meta = SubagentMetaSchema.safeParse(parsed);
    return meta.success ? present(meta.data) : {};
};

// Where the runtime filed this subagent: `<project>/<parent session>/subagents/agent-<id>.meta.json`.
const subagentFile = async (projects: string, agentId: string): Promise<{ project: string; session: string; meta: SubagentMeta } | undefined> => {
    const file = `agent-${agentId}.meta.json`;
    for (const project of (await readdir(projects).catch(undefinedIfMissing)) ?? []) {
        for (const session of (await readdir(join(projects, project)).catch(undefinedIfMissing)) ?? []) {
            const raw = await readFile(join(projects, project, session, "subagents", file), "utf8").catch(undefinedIfMissing);
            if (raw !== undefined) {
                return { project, session, meta: metaOf(raw) };
            }
        }
    }
    return undefined;
};

// The `agent/<id>` branch a session ran on, which the runtime stamps on every entry of its file.
const branchOfSession = async (file: string): Promise<string | undefined> => {
    const handle = await open(file, "r").catch(undefinedIfMissing);
    if (handle === undefined) {
        return undefined;
    }
    try {
        const buffer = Buffer.alloc(SESSION_HEAD_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, SESSION_HEAD_BYTES, 0);
        return /"gitBranch":"agent\/([^"]+)"/u.exec(buffer.subarray(0, bytesRead).toString("utf8"))?.[1];
    } finally {
        await handle.close();
    }
};

const fromSubagent = async (deps: FleetHandleDeps, agentId: string): Promise<HandleResolution | undefined> => {
    const projects = claudeProjects(deps);
    const filed = await subagentFile(projects, agentId);
    if (filed === undefined) {
        return undefined;
    }
    const what = [filed.meta.agentType, filed.meta.description].filter(Boolean).join(": ");
    const via = `${agentId} is an in-process subagent${what === "" ? "" : ` (${what})`} one of its turns started, in session ${filed.session.slice(0, 8)}`;
    const bySession = resolveHandle(deps, filed.session);
    if (bySession.kind === "found") {
        return { kind: "found", entry: bySession.entry, via };
    }
    const earlier = await fromActivity(deps, filed.session);
    if (earlier?.kind === "found") {
        return { kind: "found", entry: earlier.entry, via };
    }
    const branch = await branchOfSession(join(projects, filed.project, `${filed.session}.jsonl`));
    return branch === undefined ? undefined : found(deps, branch, via);
};

/**
 * A handle resolved through everything the daemon keeps: the registry first (resolveHandle), then, for a handle shaped
 * like one, an in-process subagent's id, a session the conversation retired, a turn or a run of it. `via` says which.
 */
export const resolveFleetHandle = async (deps: FleetHandleDeps, handle: string): Promise<HandleResolution> => {
    const wanted = handle.trim();
    const direct = resolveHandle(deps, wanted);
    if (direct.kind !== "unknown") {
        return direct;
    }
    const deeper = SUBAGENT.test(wanted)
        ? await fromSubagent(deps, wanted)
        : SESSION.test(wanted)
          ? ((await fromActivity(deps, wanted)) ?? (UUID.test(wanted) ? await fromRun(deps, wanted) : undefined))
          : undefined;
    return deeper ?? direct;
};
