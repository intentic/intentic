import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract";
import type { AgentStanding } from "../../agents/fleet/agentStatus";
import type { Conversation } from "../session/conversation";
import type { TurnPick } from "../run/turnDefaults";
import type { SessionRef } from "../run/turnRequest";
import { forgetWindowState, readWindowState, writeWindowState } from "../../../shell/window/windowStore";

// Where a sandbox's open chat tabs persist between page loads: identity, title, and composer draft, one JSON
// blob per sandbox, seeded from the last window's (windowStore has the store mechanics). Transcript content
// lives in IndexedDB instead (transcriptCache), so a restored tab paints from disk and useChat's rehydration
// then reconciles it with the daemon.

// One tab, as persisted; optional fields are values a tab can genuinely lack. No compatibility shims: a blob
// that doesn't fit is dropped, not migrated.
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
    // Persisted per tab like `fast`: armed for unattended stops, so a reload must not silently end the run.
    readonly autoContinue?: boolean;
    // The stopped-turn offer itself isn't persisted: a cached copy can't know if the daemon still holds the turn,
    // and the daemon already answers that on every hydrate (AgentTranscriptSchema.ending).
    // Automatic-tier veto, per tab like `fast`; only bridges the reload gap, since the daemon persists it too.
    readonly tierHold?: boolean;
    // Complexity judge's last verdict, not a pick; without it a reload judges the next follow-up with no history.
    readonly tier?: "fast" | "standard";
    // Persona this tab acts as, per tab only: a narrowing must never follow the user into their next chat.
    readonly actsAs?: string;
    // Session's full binding; may lag the tab's pick until the next send, so a reload can't fake the gap.
    readonly session?: SessionRef;
    // Fork source, client-only until acked; losing it before then rebuilds as an unrelated, unseeded turn.
    readonly forkOf?: { conversationId: string; keep: number; files: "then" | "now" };
    // Only being looked at (Conversation.peek); also read by the docked/popped-window handoff, not just reload.
    readonly peek?: boolean;
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
    // Messages sent before the agent received them; restored as queued, not draft, and resent on settle.
    readonly queued: { text: string; attachments: { name: string; path: string }[] }[];
}

// The one place a Conversation folds into its portable shape (StoredTab), read by both the tab-snapshot watch
// and the summons channel. JSON.stringify drops undefined keys, matching StoredTab's optional fields.
export const snapshotTab = (conversation: Conversation): StoredTab => ({
    conversationId: conversation.conversationId,
    isolated: conversation.isolated.value,
    box: conversation.box.value,
    registered: conversation.registered.value,
    provider: conversation.provider.value,
    movedFrom: conversation.movedFrom.value,
    account: conversation.account.value,
    model: conversation.model.value,
    displacedModel: conversation.displacedModel.value,
    effort: conversation.effortPick.value,
    actsAs: conversation.actsAs.value,
    thinking: conversation.thinking.value,
    fast: conversation.fast.value,
    autoContinue: conversation.autoContinue.value,
    tierHold: conversation.tierHold.value,
    tier: conversation.lastTier.value,
    harness: conversation.harness.value,
    // Session ref verbatim, never rebuilt field by field: the two must match exactly until something is switched.
    session: conversation.session.value,
    forkOf: conversation.pendingForkOf.value,
    peek: conversation.peek.value,
    standIn: conversation.standIn.value,
    standing: conversation.standing.value,
    title: conversation.title.value ?? undefined,
    draft: conversation.draft.value,
    draftAt: conversation.draftAt.value,
    attachments: conversation.attachments.value.filter((file) => file.status === `done`).map((file) => ({ name: file.name, path: file.path })),
    queued: conversation.queued.value.map((message) => ({
        text: message.text,
        attachments: message.attachments.map((file) => ({ name: file.name, path: file.path })),
    })),
});

// A sandbox's whole strip: open tabs, the focused one, and which are on screen (panes, column order). Coherent
// by construction: `active` and every pane name a tab in `tabs`, and `active` is always among the panes.
export interface TabSnapshot {
    readonly active: string;
    readonly panes: readonly string[];
    readonly tabs: readonly StoredTab[];
}

const snapshotKey = (sandboxId: string): string => `intentic.chatTabs.${sandboxId}`;

// Providers are an open vocabulary (native ids + installed ACP ids); valid when non-empty. A removed ACP id
// degrades at send time instead.
const validProvider = (value: unknown): value is AgentProvider => typeof value === `string` && value !== ``;

// Persisted shape of one attachment (upload metadata only; previewUrl/controller are client-session objects),
// read from both draft and queued entries.
const readAttachments = (raw: unknown): { name: string; path: string }[] =>
    (Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [])
        .filter((entry) => typeof entry[`name`] === `string` && typeof entry[`path`] === `string`)
        .map((entry) => ({ name: entry[`name`] as string, path: entry[`path`] as string }));

// One optional text field under its own key; spreadable, so a missing or nonsense value reads back as absence
// rather than an error.
const readText = <K extends string>(key: K, raw: unknown): { [P in K]?: string } =>
    typeof raw === `string` && raw !== `` ? ({ [key]: raw } as { [P in K]?: string }) : {};

// Same, for one recorded instant: finite or nothing, since an age computed from NaN renders as garbage
// wherever it's shown.
const readStamp = <K extends string>(key: K, raw: unknown): { [P in K]?: number } =>
    typeof raw === `number` && Number.isFinite(raw) ? ({ [key]: raw } as { [P in K]?: number }) : {};

// Same, for one provider id, on validProvider's terms.
const readProvider = <K extends string>(key: K, raw: unknown): { [P in K]?: AgentProvider } =>
    validProvider(raw) ? ({ [key]: raw } as { [P in K]?: AgentProvider }) : {};

// The displaced pick, read whole or not at all: a partial pair names a route nothing can take. An empty model
// id is real (an ACP agent brings its own), so only its type is checked.
const readMovedFrom = (raw: unknown): { movedFrom?: TurnPick } => {
    const pick = (typeof raw === `object` && raw !== null ? raw : {}) as Record<string, unknown>;
    const provider = pick[`provider`];
    const value = pick[`value`];
    return validProvider(provider) && typeof value === `string` ? { movedFrom: { provider, value } } : {};
};

// One stored flag, absent rather than false when unset: every flag has its own restore default, and reading
// "unset" as off would look like the user switched it off.
const readFlag = <K extends string>(key: K, raw: unknown): { [P in K]?: boolean } =>
    typeof raw === `boolean` ? ({ [key]: raw } as { [P in K]?: boolean }) : {};

// The session, read back whole or not at all: a partial entry names nothing resumable, and completing it from
// the tab's own picks would answer with the NEXT message's plans. `account` alone may be absent — a real
// session can be minted without one.
const readSession = (raw: unknown): { session?: SessionRef } => {
    const session = typeof raw === `object` && raw !== null ? (raw as Record<string, unknown>) : undefined;
    if (session === undefined || typeof session[`id`] !== `string` || !validProvider(session[`provider`])) {
        return {};
    }
    if (session[`harness`] !== `claude-code` && session[`harness`] !== `native`) {
        return {};
    }
    const account = session[`account`];
    return {
        session: {
            id: session[`id`],
            provider: session[`provider`],
            harness: session[`harness`],
            account: typeof account === `string` && account !== `` ? account : undefined,
        },
    };
};

// Fork linkage read back whole or not at all: a partial entry has the first send name a source the daemon
// copies the wrong prefix of.
// Where the cut fell: a whole, non-negative count of recorded rows, or nothing.
const readCut = (raw: unknown): number | undefined => (typeof raw === `number` && Number.isInteger(raw) && raw >= 0 ? raw : undefined);
// Which files the fork opens over.
const readFiles = (raw: unknown): "then" | "now" | undefined => (raw === `then` || raw === `now` ? raw : undefined);

const readFork = (raw: unknown): { forkOf?: StoredTab["forkOf"] } => {
    const fork = (typeof raw === `object` && raw !== null ? raw : {}) as Record<string, unknown>;
    const conversationId = fork[`conversationId`];
    const keep = readCut(fork[`keep`]);
    const files = readFiles(fork[`files`]);
    if (typeof conversationId !== `string` || conversationId === `` || keep === undefined || files === undefined) {
        return {};
    }
    return { forkOf: { conversationId, keep, files } };
};

// The card's account of the agent, read back only when it can still place a card: a status and the full
// attention block, since `laneOf` reads every flag and a half-read block would answer "nothing owed" for a
// question that is. The optional fields ride along as read, being plain scalars the lane only tests.
const readStanding = (raw: unknown): { standing?: AgentStanding } => {
    const standing = (typeof raw === `object` && raw !== null ? raw : {}) as Record<string, unknown>;
    const attention = (typeof standing[`attention`] === `object` && standing[`attention`] !== null ? standing[`attention`] : undefined) as
        | AgentStanding["attention"]
        | undefined;
    if (typeof standing[`status`] !== `string` || standing[`status`] === `` || attention === undefined) {
        return {};
    }
    return { standing: { ...(standing as unknown as AgentStanding), status: standing[`status`] as AgentStanding["status"], attention } };
};

// Two small closed vocabularies, read back only as one of their own members; anything else (an older build, a
// hand edit) falls to the restore's own default.
const readTier = (raw: unknown): { tier?: "fast" | "standard" } => (raw === `fast` || raw === `standard` ? { tier: raw } : {});
const readHarness = (raw: unknown): { harness?: AgentHarness } => (raw === `claude-code` || raw === `native` ? { harness: raw } : {});

// One entry, or undefined with no usable identity or draft. Skipped rather than fatal: one bad tab must not
// cost every other open chat.
const readTab = (raw: Record<string, unknown>): StoredTab | undefined => {
    if (typeof raw[`conversationId`] !== `string` || raw[`conversationId`] === `` || typeof raw[`draft`] !== `string`) {
        return undefined;
    }
    return {
        conversationId: raw[`conversationId`],
        // No worktree named means isolated: the default a fresh tab gets.
        isolated: raw[`isolated`] !== false,
        // No sandbox named means this browser's, which is what almost every tab means.
        ...readText(`box`, raw[`box`]),
        // Not marked registered until a roster frame says otherwise.
        registered: raw[`registered`] === true,
        draft: raw[`draft`],
        attachments: readAttachments(raw[`attachments`]),
        queued: (Array.isArray(raw[`queued`]) ? (raw[`queued`] as Record<string, unknown>[]) : [])
            .filter((entry) => typeof entry[`text`] === `string`)
            .map((entry) => ({ text: entry[`text`] as string, attachments: readAttachments(entry[`attachments`]) })),
        ...readProvider(`provider`, raw[`provider`]),
        ...readMovedFrom(raw[`movedFrom`]),
        ...readText(`account`, raw[`account`]),
        ...readText(`model`, raw[`model`]),
        ...readText(`displacedModel`, raw[`displacedModel`]),
        ...readText(`effort`, raw[`effort`]),
        ...readText(`actsAs`, raw[`actsAs`]),
        ...readFlag(`thinking`, raw[`thinking`]),
        ...readFlag(`fast`, raw[`fast`]),
        ...readFlag(`autoContinue`, raw[`autoContinue`]),
        ...readFlag(`peek`, raw[`peek`]),
        ...readFlag(`standIn`, raw[`standIn`]),
        ...readStanding(raw[`standing`]),
        ...readFlag(`tierHold`, raw[`tierHold`]),
        ...readTier(raw[`tier`]),
        ...readHarness(raw[`harness`]),
        ...readSession(raw[`session`]),
        ...readFork(raw[`forkOf`]),
        // An empty title reads back absent, same as an unnamed tab.
        ...readText(`title`, raw[`title`]),
        ...readStamp(`draftAt`, raw[`draftAt`]),
    };
};

// Readable tabs only, each conversation once: a duplicate id renders as two tabs sharing one key, mixing up
// names and closes. Shared with closedDrafts.ts, so both parse the identical stored shape the same way.
export const readStoredTabs = (raw: string): StoredTab[] => {
    let stored: { tabs?: unknown };
    try {
        stored = JSON.parse(raw) as { tabs?: unknown };
    } catch {
        return [];
    }
    if (!Array.isArray(stored.tabs)) {
        return [];
    }
    const seen = new Set<string>();
    const tabs: StoredTab[] = [];
    for (const entry of stored.tabs as Record<string, unknown>[]) {
        const tab = readTab(entry);
        if (tab !== undefined && !seen.has(tab.conversationId)) {
            seen.add(tab.conversationId);
            tabs.push(tab);
        }
    }
    return tabs;
};

// Parses a stored blob into a coherent snapshot: readable tabs, plus a focus and panes that name them.
const parse = (raw: string): TabSnapshot | undefined => {
    let stored: { active?: unknown; panes?: unknown };
    try {
        stored = JSON.parse(raw) as { active?: unknown; panes?: unknown };
    } catch {
        return undefined;
    }
    const tabs = readStoredTabs(raw);
    const seen = new Set(tabs.map((tab) => tab.conversationId));
    const first = tabs[0];
    if (first === undefined) {
        return undefined;
    }
    const active = typeof stored.active === `string` && seen.has(stored.active) ? stored.active : first.conversationId;
    // Keeps only panes naming a readable tab; none stored means the single-pane panel, focus shown alone.
    const panes = (Array.isArray(stored.panes) ? (stored.panes as unknown[]) : []).filter(
        (id): id is string => typeof id === `string` && seen.has(id),
    );
    return { active, panes: panes.includes(active) ? panes : [...panes, active], tabs };
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
