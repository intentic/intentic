import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { TranscriptRow, TranscriptTool } from "@intentic/sandbox-contract/events/transcript";
import type { SubagentKind, SubagentSdkRecord } from "@intentic/sandbox-contract/schemas/terminal";
import { ORPCError } from "@orpc/server";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import { turnRunOf } from "../../conversations/actor/conversation-holdings.js";
import { toolIn, type TranscriptAgent } from "../../sessions/agent-transcript.js";
import type { Services } from "../../composition.js";
import type { PersistedAgent } from "../../conversations/registry/agents-store.js";
import { readSubagentSession } from "../../sessions/sessions.js";
import { ROSTER } from "../../conversations/actor/subagent-roster.js";
import { closeSubagents, pair, readMeta, type SubagentRecord, type SubagentTurn } from "./subagents.js";

// One in-process subagent's own transcript: what a subagent its parent's runtime ran inside the parent's turn asked,
// thought, called and said, in the shape every transcript route answers in, so the chat draws it with its own rows. A
// spawned subagent is a conversation and is read as one (`agents.transcript`); this is for the kind that has none.
//
// Two stores, the fuller first:
// - the Claude runtime keeps each subagent's record beside its session, written as the subagent works, so it serves a
//   running one as well as a settled one, prose included. Where it is comes from the roster while it holds the
//   subagent, else from the delegation's card, which the turn wrote it onto, else from a search of the session the
//   conversation runs in: a restart or the roster letting go loses nothing;
// - every runtime's delegation card holds the subagent's calls and thinking under it in the parent's own record (the
//   live run's rows while the turn runs), which is all there is for another runtime.
// Empty is a real answer: nothing recorded yet.

// WHERE AN IN-PROCESS CHILD'S OWN RECORD IS, kept past the roster. The roster (subagents.ts) pairs a Claude subagent with
// the record its runtime keeps beside the session, but it is memory, and it keeps only the newest settled children: so
// the pairing is said into the turn's stream as the child pairs and again as the turn ends, which writes it onto the
// delegation's card the turn settles into (`sdk`), and a card that never said is found by searching the session.

type Actors = Pick<ConversationActors, "holdings">;

// The children whose record has been said into their turn's stream, once each: the card keeps it from then on.
const RECORDED = new WeakSet<SubagentRecord>();

// Where the Claude runtime keeps a paired in-process child's own record: the session its directory sits in, named for it,
// and the SDK's id for the child. Undefined until both are known, and for every other kind.
const sdkRecordOf = (record: SubagentRecord): SubagentSdkRecord | undefined => {
    const dir = record.turn.subagentsDir;
    return record.kind !== "subagent" || dir === undefined || record.agentId === undefined
        ? undefined
        : { sessionId: basename(dirname(dir)), agentId: record.agentId };
};

// The frame that writes where a paired child's own record is onto its card, so a reader finds it once the roster has let
// the child go or the daemon has restarted; once per child, and nothing for one not paired yet.
const recordFrame = (record: SubagentRecord): AgentEvent | undefined => {
    const sdk = RECORDED.has(record) ? undefined : sdkRecordOf(record);
    if (sdk === undefined) {
        return undefined;
    }
    RECORDED.add(record);
    return { kind: "subagent_update", id: record.id, sdk };
};

/** What SubagentStop hands each child it pairs to (subagents.ts subagentHooks): its record said into the turn's stream. */
export const recordInto =
    (push: (event: AgentEvent) => void) =>
    (child: SubagentRecord): void => {
        const frame = recordFrame(child);
        if (frame !== undefined) {
            push(frame);
        }
    };

/**
 * Pairs every in-process child this turn opened that is not paired yet, and returns the frames that write where each
 * one's own record is onto its card; said as the turn ends, so the card it settles into carries every child's, a
 * backgrounded one that outlived its SubagentStop included.
 */
const recordTurnSubagents = async (turn: SubagentTurn): Promise<AgentEvent[]> => {
    const actors = turn.conversations;
    const mine = (): SubagentRecord[] => actors.holdings(ROSTER).of(turn.conversationId).filter((record) => record.turn === turn && record.kind === "subagent");
    const dir = turn.subagentsDir;
    if (dir !== undefined && mine().some((record) => record.agentId === undefined)) {
        await pair(actors, dir, turn.conversationId);
    }
    return mine().flatMap((record) => recordFrame(record) ?? []);
};

/**
 * Where the Claude runtime keeps the record of the subagent one call started, read off the meta files beside a session:
 * for a delegation the roster no longer holds and whose card never said, one settled before cards carried it or in a
 * turn the daemon died under. `store` is the conversation's runtime store (sessions/session-store.ts), the session the
 * one it ran in. Undefined when no session folder holds it.
 */
export const findSubagentRecord = async (store: string, sessionId: string, toolUseId: string): Promise<SubagentSdkRecord | undefined> => {
    // A session id is the CLI's own UUID; anything else is never joined into a path.
    if (!/^[\w-]+$/u.test(sessionId)) {
        return undefined;
    }
    const projects = join(store, "projects");
    for (const project of (await readdir(projects, { withFileTypes: true }).catch(undefinedIfMissing)) ?? []) {
        if (!project.isDirectory()) {
            continue;
        }
        const dir = join(projects, project.name, sessionId, "subagents");
        for (const entry of (await readdir(dir).catch(undefinedIfMissing)) ?? []) {
            const agentId = /^agent-(.+)\.meta\.json$/u.exec(entry)?.[1];
            if (agentId !== undefined && (await readMeta(join(dir, entry)))?.toolUseId === toolUseId) {
                return { sessionId, agentId };
            }
        }
    }
    return undefined;
};

/** What the roster knows of one subagent that a reader of its own transcript needs (subagent-transcript.ts). */
export interface SubagentSource {
    readonly kind: SubagentKind;
    // The conversation whose turn started it.
    readonly conversationId: string;
    // Its one-line ask, the transcript's opening bubble where the runtime's own record carries no prompt.
    readonly description: string | undefined;
    // Where the Claude runtime keeps this child's own record, once it is paired to its meta file: the session it ran in
    // (the directory `subagentsDir` sits in, named for it) and the SDK's id for the child. Absent for every other runtime.
    readonly sdk: SubagentSdkRecord | undefined;
}

/** The roster's record of one subagent as its transcript's reader needs it, paired on the spot if it has not been yet. */
const subagentSource = async (actors: Actors, id: string): Promise<SubagentSource | undefined> => {
    const record = actors.holdings(ROSTER).get(id);
    if (record === undefined) {
        return undefined;
    }
    const dir = record.turn.subagentsDir;
    if (record.kind === "subagent" && record.agentId === undefined && dir !== undefined) {
        await pair(actors, dir, record.conversationId);
    }
    return {
        kind: record.kind,
        conversationId: record.conversationId,
        description: record.description,
        sdk: sdkRecordOf(record),
    };
};

/**
 * A Claude turn's end, for the children it ran in-process: each one's card told where its own record is, then any still
 * marked live closed as `killed`, which nothing else reports.
 */
export const endTurnSubagents = async (turn: SubagentTurn): Promise<AgentEvent[]> => [
    ...(await recordTurnSubagents(turn)),
    ...closeSubagents(turn.conversations, turn.conversationId),
];

export interface SubagentTranscriptDeps {
    readonly conversations: Pick<ConversationActors, "holdings">;
    // The Claude runtime's own record of one subagent, reduced to rows the way a session is; empty when it has none.
    readonly sdkMessages: (sessionId: string, agentId: string) => Promise<TranscriptRow[]>;
    // A delegation's card whole, as a conversation's settled record holds it: its calls, and its result.
    readonly toolCard: (agent: TranscriptAgent, toolId: string) => Promise<TranscriptTool | undefined>;
    // Where the Claude runtime keeps the record of the subagent this call started, searched for in the session the
    // conversation runs in; undefined for another runtime, or when no session holds it.
    readonly findSdkRecord: (toolUseId: string) => Promise<SubagentSdkRecord | undefined>;
}

// The ask, as the first user bubble: the calls alone carry no prompt of their own.
const askedOf = (asked: string | undefined): TranscriptRow[] =>
    asked !== undefined && asked.trim().length > 0 ? [{ role: "user", text: asked }] : [];

// What the subagent reported, as its parent read it: the text of the delegation's result, empty while it works.
const reportOf = (card: TranscriptTool): string =>
    (card.content ?? [])
        .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
        .join("\n\n")
        .trim();

// The delegation's card, from the parent's run while it is held (fresher than the record, which is written as rows
// settle), else from the parent's record.
const cardOf = async (deps: SubagentTranscriptDeps, parentId: string, id: string): Promise<TranscriptTool | undefined> => {
    const rows = turnRunOf(deps.conversations, parentId)?.rows ?? [];
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const held = toolIn(rows[index]?.tools ?? [], id);
        if (held !== undefined) {
            return held;
        }
    }
    return deps.toolCard({ id: parentId }, id);
};

// Where the Claude runtime keeps this subagent's record: the roster's pairing while it holds the subagent, untouched for
// one it holds unpaired (a running child whose meta file is still to come); else the card's, for one the roster let go;
// else the search, for a card that never said (settled before cards carried it, or in a turn the daemon died under).
const sdkRecordFor = async (
    deps: SubagentTranscriptDeps,
    id: string,
    source: SubagentSource | undefined,
    card: () => Promise<TranscriptTool | undefined>,
): Promise<SubagentSdkRecord | undefined> => {
    if (source !== undefined) {
        return source.sdk;
    }
    const settled = await card();
    if (settled === undefined || (settled.subagent !== undefined && settled.subagent.kind !== "subagent")) {
        return undefined;
    }
    return settled.subagent?.sdk ?? (await deps.findSdkRecord(id));
};

export const readSubagentTranscript = async (deps: SubagentTranscriptDeps, parentId: string, id: string): Promise<TranscriptRow[]> => {
    const source = await subagentSource(deps.conversations, id);
    if (source !== undefined && source.conversationId !== parentId) {
        throw new ORPCError("NOT_FOUND", { message: "no subagent of this conversation has that id" });
    }
    if (source?.kind === "spawned") {
        throw new ORPCError("BAD_REQUEST", { message: "a spawned subagent is a conversation of its own: read its transcript" });
    }
    // Read once whichever needs it first: the card is a walk back through the record.
    let held: Promise<TranscriptTool | undefined> | undefined;
    const cardOnce = (): Promise<TranscriptTool | undefined> => (held ??= cardOf(deps, parentId, id));
    const sdk = await sdkRecordFor(deps, id, source, cardOnce);
    if (sdk !== undefined) {
        const own = await deps.sdkMessages(sdk.sessionId, sdk.agentId);
        if (own.length > 0) {
            return own;
        }
    }
    const card = await cardOnce();
    const calls = card?.children ?? [];
    const report = card === undefined ? "" : reportOf(card);
    if (card === undefined || (calls.length === 0 && report === "")) {
        return [];
    }
    return [...askedOf(source?.description ?? card.target), { role: "assistant", text: report, ...(calls.length > 0 ? { tools: calls } : {}) }];
};

/**
 * The same, as the route asks it: the parent conversation's entry, the session its Claude runtime holds now (undefined
 * for another runtime), and the subagent's id.
 */
export const subagentTranscriptOf = (
    services: Pick<Services, "conversations" | "workspace" | "transcripts" | "agentWorktrees">,
    parent: PersistedAgent,
    sessionId: string | undefined,
    id: string,
): Promise<TranscriptRow[]> =>
    readSubagentTranscript(
        {
            conversations: services.conversations,
            sdkMessages: (session, agentId) => readSubagentSession(services.workspace.root, session, agentId),
            toolCard: (agent, toolId) => services.transcripts.toolCard(agent, toolId),
            findSdkRecord: async (toolUseId) =>
                sessionId === undefined ? undefined : findSubagentRecord(services.agentWorktrees.sessionStore(parent), sessionId, toolUseId),
        },
        parent.id,
        id,
    );
