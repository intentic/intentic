import { type AgentHarness, AgentHarnessSchema, type AgentProvider, AgentProviderSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import type { AgentStanding } from "../../agents/fleet/agentStatus";
import type { Conversation } from "../session/conversation";
import type { TurnPick } from "../run/turnDefaults";
import type { ForkLink, SessionRef } from "../run/turnRequest";
import type { ChatRunView } from "../run/chatRun";
import { forgetWindowState, readWindowState, writeWindowState } from "../../../shell/window/windowStore";

// Where a sandbox's open chat tabs persist between page loads: identity, title, and composer draft, one JSON
// blob per sandbox, seeded from the last window's (windowStore has the store mechanics). Transcript content
// lives in IndexedDB instead (transcriptCache), so a restored tab paints from disk and useChat's rehydration
// then reconciles it with the daemon.

// One tab, as persisted; optional fields are values a tab can genuinely lack. A blob that doesn't fit is dropped, not migrated.
export interface StoredTab {
    // The daemon-side conversation identity and the tab's identity in the strip; an entry without one is dropped.
    readonly conversationId: string;
    // Whether the conversation runs in its own isolated worktree rather than on the shared /work tree.
    readonly isolated: boolean;
    // Which sandbox this runs in; it's the tab's address, so losing it misreads a live agent as stopped.
    readonly box?: string;
    // Whether the fleet has registered this; avoids reload flashing tabs as drafts before the roster arrives.
    readonly registered: boolean;
    // The tab's turn selection; may differ from the session's provider while a switch is picked but not sent.
    readonly provider?: AgentProvider;
    // Pick the app moved this tab to because it couldn't send; outlives the window that made it.
    readonly movedFrom?: TurnPick;
    // The tab's harness selection (native vs the Claude Code loop); absent means the current default on restore.
    readonly harness?: AgentHarness;
    // Per-tab account pick; applying the remembered default to open tabs would silently move them.
    readonly account?: string;
    // Persisted per tab like `account`, so reload can't reseed an open tab's model from another tab's pick.
    readonly model?: string;
    // The pick a thin catalog moved this tab off, owed back when the model is offered again; without it a reload
    // settles the app's substitution as if the user had made it.
    readonly displacedModel?: string;
    readonly effort?: string;
    readonly thinking?: boolean;
    // Persisted per tab, not remembered globally: a reload keeps this chat's setting, but a new chat starts off.
    readonly fast?: boolean;
    // The stopped-turn offer itself isn't persisted: a cached copy can't know if the daemon still holds the turn,
    // and the daemon already answers that on every hydrate (AgentTranscriptSchema.ending).
    // Chat is on Auto with its model still unchosen. Per tab, since it describes this chat's unanswered question, and
    // a reload without it would show a model the owner never picked as though they had.
    readonly auto?: boolean;
    // Persona this tab acts as, per tab only: a narrowing must never follow the user into their next chat.
    readonly actsAs?: string;
    // Session's full binding; may lag the tab's pick until the next send, so a reload can't fake the gap.
    readonly session?: SessionRef;
    // Fork source, client-only until acked; losing it before then rebuilds as an unrelated, unseeded turn.
    readonly forkOf?: ForkLink;
    // Only being looked at (Conversation.peek); also read by the docked/popped-window handoff, not just reload.
    readonly peek?: boolean;
    // Held on purpose (Conversation.pinned); reopening a closed pinned chat keeps it held.
    readonly pinned?: boolean;
    // When focus last left the chat, so the tidy clock survives a reload (Conversation.leftAt).
    readonly leftAt?: number;
    // The panel's fallback blank; losing it on handoff boards a fresh, selected "New agent" card.
    readonly standIn?: boolean;
    // The daemon's account of the agent when its card opened this chat, so a window whose roster hasn't answered
    // still lanes it the way the board does (Conversation.standing).
    readonly standing?: AgentStanding;
    readonly title?: string;
    readonly draft: string;
    // When the draft first went unsent, so its age survives reload instead of resetting to "just now".
    readonly draftAt?: number;
    readonly attachments: { name: string; path: string }[];
}

// The one place a Conversation folds into its portable shape (StoredTab), read by both the tab-snapshot watch
// and the summons channel. JSON.stringify drops undefined keys, matching StoredTab's optional fields.
export const snapshotTab = (conversation: Conversation): StoredTab => ({
    conversationId: conversation.conversationId,
    isolated: conversation.isolated.value,
    box: conversation.box.value,
    registered: conversation.registered.value,
    provider: conversation.selection.provider.value,
    movedFrom: conversation.selection.movedFrom.value,
    account: conversation.selection.account.value,
    model: conversation.selection.model.value,
    displacedModel: conversation.selection.displacedModel.value,
    effort: conversation.selection.effortPick.value,
    actsAs: conversation.selection.actsAs.value,
    thinking: conversation.selection.thinking.value,
    fast: conversation.selection.fast.value,
    auto: conversation.selection.auto.value,
    harness: conversation.selection.harness.value,
    // Session ref verbatim, never rebuilt field by field: the two must match exactly until something is switched.
    session: conversation.session.value,
    forkOf: conversation.pendingForkOf.value,
    peek: conversation.peek.value,
    pinned: conversation.pinned.value,
    leftAt: conversation.leftAt.value,
    standIn: conversation.standIn.value,
    standing: conversation.standing.value,
    title: conversation.title.value ?? undefined,
    draft: conversation.draft.value,
    draftAt: conversation.draftAt.value,
    attachments: conversation.attachments.value.filter((file) => file.status === `done`).map((file) => ({ name: file.name, path: file.path })),
});

// A sandbox's whole strip: open tabs, the focused one, and which are on screen (panes, column order). Coherent
// by construction: `active` and every pane name a tab in `tabs`, and `active` is always among the panes.
export interface TabSnapshot {
    readonly run?: ChatRunView;
    readonly active: string;
    readonly panes: readonly string[];
    readonly tabs: readonly StoredTab[];
}

const snapshotKey = (sandboxId: string): string => `intentic.chatTabs.${sandboxId}`;

// A field that reads back unusable is absent, so the restore falls to that field's own default rather than failing the tab.
const maybe = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const text = maybe(z.string().min(1));
const flag = maybe(z.boolean());

const AttachmentSchema = z.object({ name: z.string(), path: z.string() });
const SessionSchema = z
    .object({ id: z.string(), provider: AgentProviderSchema, harness: AgentHarnessSchema, account: text })
    .transform(({ id, provider, harness, account }): SessionRef => ({ id, provider, harness, account }));

// Composite fields read back whole or not at all: a partial session, fork or displaced pick names nothing usable.
const StoredTabSchema: z.ZodType<StoredTab> = z.object({
    conversationId: z.string().min(1),
    draft: z.string(),
    // No worktree named means isolated, the default a fresh tab gets; registered waits for a roster frame.
    isolated: z
        .unknown()
        .optional()
        .transform((raw) => raw !== false),
    registered: z
        .unknown()
        .optional()
        .transform((raw) => raw === true),
    attachments: z
        .array(z.unknown())
        .catch([])
        .transform((entries) => entries.flatMap((entry) => AttachmentSchema.safeParse(entry).data ?? [])),
    box: text,
    provider: maybe(AgentProviderSchema),
    movedFrom: maybe(z.object({ provider: AgentProviderSchema, value: z.string() })),
    harness: maybe(AgentHarnessSchema),
    account: text,
    model: text,
    displacedModel: text,
    effort: text,
    thinking: flag,
    fast: flag,
    auto: flag,
    actsAs: text,
    session: maybe(SessionSchema),
    forkOf: maybe(z.object({ conversationId: z.string().min(1), keep: z.number().int().nonnegative(), files: z.enum([`then`, `now`]) })),
    peek: flag,
    pinned: flag,
    leftAt: maybe(z.number()),
    standIn: flag,
    // A status and the whole attention block, since `laneOf` reads every flag; the rest rides along as stored.
    standing: maybe(z.looseObject({ status: z.string().min(1), attention: z.looseObject({}) }).transform((raw) => raw as unknown as AgentStanding)),
    title: text,
    draftAt: maybe(z.number()),
});
const StoredStripSchema = z.object({
    tabs: z.array(z.unknown()),
    active: z.unknown().optional(),
    panes: z.array(z.unknown()).catch([]),
    run: maybe(z.object({ runId: z.string(), mode: z.enum([`graph`, `live`, `pinned`]) })),
});

const readStrip = (raw: string): z.infer<typeof StoredStripSchema> | undefined => {
    try {
        return StoredStripSchema.safeParse(JSON.parse(raw)).data;
    } catch {
        return undefined;
    }
};

// Readable tabs only, each conversation once: a duplicate id renders as two tabs sharing one key, mixing up
// names and closes. Shared with closedDrafts.ts, so both parse the identical stored shape the same way.
export const readStoredTabs = (raw: string): StoredTab[] => {
    const seen = new Set<string>();
    return (readStrip(raw)?.tabs ?? []).flatMap((entry) => {
        // An entry with no usable identity or draft is skipped: one bad tab must not cost every other open chat.
        const tab = StoredTabSchema.safeParse(entry).data;
        if (tab === undefined || seen.has(tab.conversationId)) {
            return [];
        }
        seen.add(tab.conversationId);
        return [tab];
    });
};

// Parses a stored blob into a coherent snapshot: readable tabs, plus a focus and panes that name them.
const parse = (raw: string): TabSnapshot | undefined => {
    const stored = readStrip(raw);
    const tabs = readStoredTabs(raw);
    const first = tabs[0];
    if (stored === undefined || first === undefined) {
        return undefined;
    }
    const seen = new Set(tabs.map((tab) => tab.conversationId));
    const active = typeof stored.active === `string` && seen.has(stored.active) ? stored.active : first.conversationId;
    // Keeps only panes naming a readable tab; none stored means the single-pane panel, focus shown alone.
    const panes = stored.panes.filter((id): id is string => typeof id === `string` && seen.has(id));
    return { active, panes: panes.includes(active) ? panes : [...panes, active], tabs, run: stored.run };
};

// This window's tabs for a sandbox, else the last window's (the seed) if this one never opened it.
export const readTabSnapshot = (sandboxId: string | undefined): TabSnapshot | undefined =>
    sandboxId === undefined ? undefined : readWindowState(snapshotKey(sandboxId), parse);

// Persists this window's strip. Takes the serialized string because the store watches it, making "did any
// field change" one cheap comparison; re-serializing here would repeat that.
export const writeTabSnapshot = (sandboxId: string, json: string): void => {
    writeWindowState(snapshotKey(sandboxId), json);
};

// Stops claiming this sandbox's strip while another window draws the chat. The next read falls to the seed,
// so taking the panel back resumes where that window left it.
export const forgetTabSnapshot = (sandboxId: string | undefined): void => {
    if (sandboxId !== undefined) {
        forgetWindowState(snapshotKey(sandboxId));
    }
};
