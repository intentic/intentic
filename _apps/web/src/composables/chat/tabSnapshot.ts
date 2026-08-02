import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract";
import { readWindowState, writeWindowState } from "../windowStore";

/* Where a sandbox's open chat tabs live between page loads: session/provider identity, title, and the composer
 * draft (text + done-upload metadata), as one JSON blob per sandbox — this window's own, seeded by the last
 * window's (windowStore holds the two-store mechanics and why). Transcript CONTENT is not in here — it is
 * mirrored to IndexedDB instead (see transcriptCache), so a restored tab paints from disk at once and useChat's
 * rehydration watch then reconciles it with the daemon. */

// One tab, as persisted. Everything optional is a value the tab can genuinely lack; nothing here is a
// compatibility shim, so a blob that doesn't fit is dropped rather than migrated.
export interface StoredTab {
    // The stable daemon-side conversation identity (fleet registry + worktree key), and the tab's identity in
    // the strip. An entry without one names nothing and is dropped.
    readonly conversationId: string;
    // Whether the conversation runs in its own isolated worktree rather than on the shared /work tree.
    readonly isolated: boolean;
    // Whether the fleet has ever registered this conversation (Conversation.registered). Persisted so a reload
    // doesn't hand every open agent tab back to the board as a fresh draft card while the first roster frame
    // is still in flight — and never at all for one whose agent has since been archived.
    readonly registered: boolean;
    // The tab's turn selection; the session's provider may differ while a switch is picked but not yet sent.
    readonly provider?: AgentProvider;
    // The tab's harness selection (native vs the Claude Code loop); absent ⇒ the current default on restore.
    readonly harness?: AgentHarness;
    // Which of the provider's accounts this tab's next turn runs on. Per TAB, not merely per provider: the
    // remembered pick seeds NEW conversations, and applying it to the open ones would quietly move a chat off
    // the account it has been running on because another tab was switched. Absent ⇒ the remembered pick.
    readonly account?: string;
    // The tab's model / reasoning effort / extended-thinking picks, persisted for the SAME reason `account` is:
    // the remembered picks (turnDefaults) seed a NEW conversation, and re-seeding the open ones from them on a
    // reload is how a chat that ran on Sonnet came back claiming whatever model another tab was last switched
    // to. Absent ⇒ the remembered pick, which is what a tab persisted before this was stored was showing.
    readonly model?: string;
    readonly effort?: string;
    readonly thinking?: boolean;
    // The fast-speed pick, persisted per TAB for the same reason and NOT remembered globally: it is a property
    // of this chat, and a reload should show the same chat back — but a new chat starts from off (turnDefaults
    // deliberately doesn't carry it; see Conversation.fast).
    readonly fast?: boolean;
    // `account` is the one the SESSION was minted on, which is not always the tab's current pick — a mid-chat
    // switch takes effect at the next send, and until then the two differ on purpose (that difference is what
    // retires the session then). Restoring both keeps a reload from either forging the match or faking the
    // mismatch.
    readonly session?: { id: string; provider: AgentProvider; account?: string };
    readonly title?: string;
    readonly draft: string;
    readonly attachments: { name: string; path: string }[];
    // Messages submitted while a turn ran that hadn't reached the agent yet — user-written text, so a refresh
    // must not swallow them. They restore as queued (not as draft, which would collide with the real draft)
    // and go out when the tab's turn settles or with the user's next send. The editor-context chip on one is
    // deliberately dropped: it points at a selection this window no longer has.
    readonly queued: { text: string; attachments: { name: string; path: string }[] }[];
}

// A sandbox's whole strip: the open tabs and which one is focused, named by conversationId. Coherent by
// construction — `active` always names one of `tabs`, and no conversation appears twice.
export interface TabSnapshot {
    readonly active: string;
    readonly tabs: readonly StoredTab[];
}

const snapshotKey = (sandboxId: string): string => `intentic.chatTabs.${sandboxId}`;

// Providers are an open string vocabulary (native ids + installed ACP agent ids) — a stored provider is valid
// when non-empty; a since-removed ACP id degrades at send time (the daemon's unknown-provider error frame).
const validProvider = (value: unknown): value is AgentProvider => typeof value === `string` && value !== ``;

// The persisted shape of one attachment (upload metadata only — previewUrl/controller are client-session
// objects), read back defensively from the tab snapshot's draft and queued entries alike.
const readAttachments = (raw: unknown): { name: string; path: string }[] =>
    (Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [])
        .filter((entry) => typeof entry[`name`] === `string` && typeof entry[`path`] === `string`)
        .map((entry) => ({ name: entry[`name`] as string, path: entry[`path`] as string }));

// One optional text field — an account pin, a model id, an effort tier — under the key its owner carries it in.
// Spreadable, so a blob with nothing (or nonsense) where a value should be reads back as the absence the
// restore already falls back from.
const readText = <K extends string>(key: K, raw: unknown): { [P in K]?: string } =>
    typeof raw === `string` && raw !== `` ? ({ [key]: raw } as { [P in K]?: string }) : {};

// One entry, or undefined when it carries no usable identity or draft. Skipped rather than fatal: a single
// unreadable tab must not cost the user every other chat they had open.
const readTab = (raw: Record<string, unknown>): StoredTab | undefined => {
    if (typeof raw[`conversationId`] !== `string` || raw[`conversationId`] === `` || typeof raw[`draft`] !== `string`) {
        return undefined;
    }
    const session = raw[`session`] as Record<string, unknown> | null | undefined;
    const validSession =
        typeof session === `object` && session !== null && typeof session[`id`] === `string` && validProvider(session[`provider`])
            ? { id: session[`id`] as string, provider: session[`provider`], ...readText(`account`, session[`account`]) }
            : undefined;
    return {
        conversationId: raw[`conversationId`],
        // A tab that names no tree runs in its own worktree — the default a fresh one gets.
        isolated: raw[`isolated`] !== false,
        // ...and one that doesn't say the fleet knows it is a draft until a roster frame says otherwise.
        registered: raw[`registered`] === true,
        draft: raw[`draft`],
        attachments: readAttachments(raw[`attachments`]),
        queued: (Array.isArray(raw[`queued`]) ? (raw[`queued`] as Record<string, unknown>[]) : [])
            .filter((entry) => typeof entry[`text`] === `string`)
            .map((entry) => ({ text: entry[`text`] as string, attachments: readAttachments(entry[`attachments`]) })),
        ...(validProvider(raw[`provider`]) ? { provider: raw[`provider`] } : {}),
        ...readText(`account`, raw[`account`]),
        ...readText(`model`, raw[`model`]),
        ...readText(`effort`, raw[`effort`]),
        ...(typeof raw[`thinking`] === `boolean` ? { thinking: raw[`thinking`] } : {}),
        ...(typeof raw[`fast`] === `boolean` ? { fast: raw[`fast`] } : {}),
        ...(raw[`harness`] === `claude-code` || raw[`harness`] === `native` ? { harness: raw[`harness`] as AgentHarness } : {}),
        ...(validSession !== undefined ? { session: validSession } : {}),
        ...(typeof raw[`title`] === `string` ? { title: raw[`title`] } : {}),
    };
};

// Parse one stored blob into a coherent snapshot: readable tabs only, each conversation once (a duplicate id
// would render as two tabs sharing a key, which is how a strip ends up with the wrong name on the wrong tab
// and a × that removes neither), and a focus that names one of them.
const parse = (raw: string): TabSnapshot | undefined => {
    let stored: { active?: unknown; tabs?: unknown };
    try {
        stored = JSON.parse(raw) as { active?: unknown; tabs?: unknown };
    } catch {
        return undefined;
    }
    if (!Array.isArray(stored.tabs)) {
        return undefined;
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
    const first = tabs[0];
    if (first === undefined) {
        return undefined;
    }
    const active = typeof stored.active === `string` && seen.has(stored.active) ? stored.active : first.conversationId;
    return { active, tabs };
};

// This window's tabs for a sandbox, else the last window's (the seed) when this one has never opened it.
export const readTabSnapshot = (sandboxId: string | undefined): TabSnapshot | undefined =>
    sandboxId === undefined ? undefined : readWindowState(snapshotKey(sandboxId), parse);

// Persist this window's strip. Takes the serialized snapshot because the store watches that string: it is what
// makes "any field of any tab changed" a single cheap comparison, so re-serializing here would only repeat it.
export const writeTabSnapshot = (sandboxId: string, json: string): void => {
    writeWindowState(snapshotKey(sandboxId), json);
};
