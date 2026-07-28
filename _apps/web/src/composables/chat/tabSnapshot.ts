import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract";

/* Where a sandbox's open chat tabs live between page loads: session/provider identity, title, and the composer
 * draft (text + done-upload metadata), as one JSON blob per sandbox. Transcript CONTENT is not in here — it is
 * mirrored to IndexedDB instead (see transcriptCache), so a restored tab paints from disk at once and useChat's
 * rehydration watch then reconciles it with the daemon.
 *
 * TWO STORES, because a tab set belongs to a WINDOW and a sandbox outlives every window that ever opened it:
 *
 *   · sessionStorage — this window's own tabs. Per browser tab, and it survives a reload (including the dev
 *     server's live-reload and a crash restore), which is exactly the lifetime an open tab set has. This is
 *     the authority: what this window restores is what this window last showed.
 *   · localStorage — the same blob as a SEED, read only by a window that has never opened this sandbox. It is
 *     how "open the app, your chats are still there" survives closing the browser.
 *
 * One shared key for both roles is what the split fixes. Every open window rewrites the snapshot on every
 * keystroke, upload and streamed title, so with several sessions open the last writer won: a window came back
 * from a reload wearing another window's tabs (wrong names, transcripts it had never cached, so empty), and a
 * tab closed in one window was resurrected by the next write from another. Windows are supposed to differ —
 * the daemon multiplexes attach streams and the presence roster counts viewers per connection precisely so two
 * windows can sit on different chats — and now their tab sets can too. The seed write stays last-writer-wins,
 * which is harmless: no window ever reads it back while it is open. */

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
    readonly session?: { id: string; provider: AgentProvider };
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

// Storage can be missing entirely (private mode, disabled site data) and merely TOUCHING it throws there, so
// both accessors are guarded: a read degrades to "no snapshot" and a write to a no-op, which leaves exactly
// the in-memory tabs this window already holds.
const readFrom = (storage: () => Storage, key: string): string | null => {
    try {
        return storage().getItem(key);
    } catch {
        return null;
    }
};

const writeTo = (storage: () => Storage, key: string, json: string): void => {
    try {
        storage().setItem(key, json);
    } catch {
        // Unavailable or over quota; the in-memory tabs still hold for the life of the window.
    }
};

// Providers are an open string vocabulary (native ids + installed ACP agent ids) — a stored provider is valid
// when non-empty; a since-removed ACP id degrades at send time (the daemon's unknown-provider error frame).
const validProvider = (value: unknown): value is AgentProvider => typeof value === `string` && value !== ``;

// The persisted shape of one attachment (upload metadata only — previewUrl/controller are client-session
// objects), read back defensively from the tab snapshot's draft and queued entries alike.
const readAttachments = (raw: unknown): { name: string; path: string }[] =>
    (Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [])
        .filter((entry) => typeof entry[`name`] === `string` && typeof entry[`path`] === `string`)
        .map((entry) => ({ name: entry[`name`] as string, path: entry[`path`] as string }));

// One entry, or undefined when it carries no usable identity or draft. Skipped rather than fatal: a single
// unreadable tab must not cost the user every other chat they had open.
const readTab = (raw: Record<string, unknown>): StoredTab | undefined => {
    if (typeof raw[`conversationId`] !== `string` || raw[`conversationId`] === `` || typeof raw[`draft`] !== `string`) {
        return undefined;
    }
    const session = raw[`session`] as Record<string, unknown> | null | undefined;
    const validSession =
        typeof session === `object` && session !== null && typeof session[`id`] === `string` && validProvider(session[`provider`])
            ? { id: session[`id`] as string, provider: session[`provider`] }
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
        ...(raw[`harness`] === `claude-code` || raw[`harness`] === `native` ? { harness: raw[`harness`] as AgentHarness } : {}),
        ...(validSession !== undefined ? { session: validSession } : {}),
        ...(typeof raw[`title`] === `string` ? { title: raw[`title`] } : {}),
    };
};

// Parse one stored blob into a coherent snapshot: readable tabs only, each conversation once (a duplicate id
// would render as two tabs sharing a key, which is how a strip ends up with the wrong name on the wrong tab
// and a × that removes neither), and a focus that names one of them.
const parse = (raw: string | null): TabSnapshot | undefined => {
    if (raw === null) {
        return undefined;
    }
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
export const readTabSnapshot = (sandboxId: string | undefined): TabSnapshot | undefined => {
    if (sandboxId === undefined) {
        return undefined;
    }
    const key = snapshotKey(sandboxId);
    return parse(readFrom(() => sessionStorage, key)) ?? parse(readFrom(() => localStorage, key));
};

// Persist this window's strip. Takes the serialized snapshot because the store watches that string: it is what
// makes "any field of any tab changed" a single cheap comparison, so re-serializing here would only repeat it.
export const writeTabSnapshot = (sandboxId: string, json: string): void => {
    const key = snapshotKey(sandboxId);
    writeTo(() => sessionStorage, key, json);
    writeTo(() => localStorage, key, json);
};
