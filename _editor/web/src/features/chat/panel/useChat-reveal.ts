import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract";
import { claimClosedDrafts } from "../drafts/closedDrafts";
import { drawsChat } from "../run/chatEcho";
import { Conversation } from "../session/conversation";
import type { StoredTab } from "../tabs/tabSnapshot";
import {
    active,
    claimColumnBeside,
    closePane,
    collapsePanes,
    conversations,
    focusComposer,
    restoreComposer,
    restoreTab,
    setActive,
    setConversations,
    setPanes,
    untouchedDraft,
} from "../tabs/useChat-tabs";
import { fetchTranscript, hydrateOnce, sessions } from "../run/useChat-sessions";
import { uuid } from "../../../lib/uuid";

// One verb set every summons applies identically in every window: outside surfaces hand what to show to summon.ts,
// which runs this and broadcasts it; the panel's own controls call these store verbs directly.
// - show: this chat as the whole panel; other panes collapse.
// - focus: this chat in the focused column; other panes stand.
// - beside: this chat in a new column, right of the focused pane.
// - panes: exactly this set, side by side, in this order.
// - unpane: give the chat's column back.
export type RevealVerb = `show` | `focus` | `beside` | `panes` | `unpane`;

// A chat in whatever form the summoning surface holds it: a live Conversation, a StoredTab (also the wire shape between
// windows), or a session reference whose conversationId the summoner mints so every window agrees on identity.
export type RevealEntry = Conversation | StoredTab | { readonly conversationId: string; readonly sessionRef: string; readonly title?: string };

export interface Reveal {
    readonly verb: RevealVerb;
    readonly entries: readonly RevealEntry[];
    // Which entry has focus, by the summoner's conversationId; resolves to an already-open tab under another id.
    readonly focus: string;
    // Puts the caret in the composer, for a press that means to start typing.
    readonly caret: boolean;
    // Marks only newly created tabs as a peek (swept once focus leaves); already-open tabs keep their standing.
    readonly peek?: boolean;
    // Drafts these chats were closed holding, claimed once so every window restores the same composer.
    readonly unsent?: readonly StoredTab[];
}

// The transcript round-trip behind a session entry, off the reveal's synchronous path.
const loadSession = async (conversation: Conversation, sessionRef: string, title: string | null): Promise<void> => {
    try {
        const restored = await fetchTranscript(conversation, sessionRef);
        if (restored !== undefined) {
            conversation.loadTranscript(restored, sessionRef, title);
        }
    } finally {
        conversation.loading.value = false;
    }
};

// Merges a closed draft back into its tab. A registered agent's remembered fields overlay a stored copy's; a
// client-only draft's kept copy wins outright, since its seed knows nothing the kept tab doesn't.
const withClosedDraft = (entry: StoredTab, kept: StoredTab | undefined): StoredTab => {
    if (kept === undefined) {
        return entry;
    }
    const stated = Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as Partial<StoredTab>;
    const merged = entry.registered ? { ...kept, ...stated } : { ...stated, ...kept };
    // The kept tab's composer always wins; that's the reason this entry exists.
    return { ...merged, draft: kept.draft, draftAt: kept.draftAt, attachments: kept.attachments, queued: kept.queued };
};

// Puts closed-out words back into a tab this window already has open. Only into an empty composer, never over words
// being typed live.
const restoreKept = (conversation: Conversation, kept: StoredTab | undefined): void => {
    if (kept !== undefined && !conversation.unsent.value) {
        restoreComposer(conversation, kept);
    }
};

// Resolves one entry to the open Conversation it means in this window, matching by id or by shown session so a repeated
// summons focuses the existing tab instead of minting a twin. New conversations go into `additions`.
const resolveEntry = (entry: RevealEntry, additions: Conversation[], kept: ReadonlyMap<string, StoredTab>): Conversation => {
    const opened = [...conversations.value, ...additions];
    const byId = opened.find((conversation) => conversation.conversationId === entry.conversationId);
    if (entry instanceof Conversation) {
        if (byId !== undefined) {
            return byId;
        }
        additions.push(entry);
        return entry;
    }
    if (`sessionRef` in entry) {
        const existing = opened.find((conversation) => conversation.session.value?.id === entry.sessionRef) ?? byId;
        if (existing !== undefined) {
            return existing;
        }
        const conversation = new Conversation(entry.conversationId);
        // Titled before the transcript loads, so a nameless loading tab isn't mistaken for an untouched draft and swept
        // mid-load.
        conversation.title.value = entry.title ?? null;
        // A history row names a session, not a composer, so kept drafts are the only record of what was waiting to
        // send.
        restoreKept(conversation, kept.get(entry.conversationId));
        conversation.loading.value = true;
        void loadSession(conversation, entry.sessionRef, entry.title ?? null);
        additions.push(conversation);
        return conversation;
    }
    const session = entry.session;
    const existing = byId ?? (session === undefined ? undefined : opened.find((conversation) => conversation.session.value?.id === session.id));
    if (existing !== undefined) {
        // Words a close in another window set aside come back here, never over ones being typed now.
        restoreKept(existing, kept.get(entry.conversationId));
        // Marks the agent as fleet-known so an opened card doesn't reappear on the board as a phantom draft.
        if (entry.registered) {
            existing.registered.value = true;
            existing.isolated.value = entry.isolated;
        }
        // Re-opening re-hydrates even an already-shown tab, since it may be a stub from a dead attach; skipped while
        // streaming, since the tab IS the stream.
        if (!existing.streaming.value) {
            hydrateOnce(existing);
        }
        return existing;
    }
    // Never open here: built fresh from the snapshot, exactly as a reload would. Hydrated outright rather than left to
    // the reachability watch, so a running turn attaches live and a settled one replays.
    const conversation = restoreTab(withClosedDraft(entry, kept.get(entry.conversationId)));
    additions.push(conversation);
    hydrateOnce(conversation);
    return conversation;
};

// Drafts a reveal is bringing back, by conversation: carried on the summons if claimed already, else claimed here for a
// reveal this window makes alone. Claimed once for the whole reveal, not per entry.
const keptFor = (entries: readonly RevealEntry[], unsent: readonly StoredTab[] | undefined): ReadonlyMap<string, StoredTab> =>
    new Map((unsent ?? claimClosedDrafts(entries.map((entry) => entry.conversationId))).map((tab) => [tab.conversationId, tab] as const));

// Marks newly created tabs as a peek before the list write seats them, so the snapshot watch never sees an unmarked
// peek. Leaves already-open tabs' standing untouched.
const markPeeked = (peek: boolean | undefined, additions: readonly Conversation[]): void => {
    if (peek !== true) {
        return;
    }
    for (const conversation of additions) {
        conversation.peek.value = true;
    }
};

// Returns the conversation the focus resolved to, for callers that need the live instance; `unpane` shows nothing, so
// it returns nothing.
export const reveal = ({ verb, entries, focus, caret, unsent, peek }: Reveal): Conversation | undefined => {
    if (verb === `unpane`) {
        closePane(focus);
        return undefined;
    }
    const additions: Conversation[] = [];
    const kept = keptFor(entries, unsent);
    const resolved = entries.map((entry) => resolveEntry(entry, additions, kept));
    // The focus as this window knows it (resolveEntry may have aliased it to an existing tab).
    const at = entries.findIndex((entry) => entry.conversationId === focus);
    const focusId = (at === -1 ? undefined : resolved[at]?.conversationId) ?? focus;
    // The column is claimed before the list write, so an arriving chat with no column of its own takes the focused
    // pane's.
    if (verb === `beside`) {
        claimColumnBeside(focusId);
    }
    markPeeked(peek, additions);
    if (additions.length > 0) {
        setConversations([...conversations.value, ...additions], focusId, `reveal-${verb}`);
    }
    // Called even when the write above already seated the focus: the reveal counter still needs to bring the tab into
    // view in a scrolled rail.
    setActive(focusId);
    if (verb === `panes`) {
        setPanes(resolved.map((conversation) => conversation.conversationId));
    } else if (verb === `show`) {
        // After the write, so the pane kept is the one just seated. Other chats stay open; this only gives back their
        // columns.
        collapsePanes();
    }
    if (caret) {
        focusComposer();
    }
    return resolved.find((conversation) => conversation.conversationId === focusId);
};

// An agent's registry summary folded into the portable tab shape, for opening a chat that may not have a tab yet. One
// hydrate path serves workspace and isolated conversations alike.
export interface AgentTabSeed {
    id: string;
    // Which sandbox the agent lives in; absent means this browser's own box.
    sandboxId?: string;
    sessionId?: string;
    title?: string;
    provider: AgentProvider;
    harness: AgentHarness;
    // Present exactly when this conversation owns an isolated worktree; clears Conversation's isolated-by-default
    // posture.
    branch?: string;
    account?: string;
    // What the agent's turns actually ran with; absent only for an agent that has never run one.
    model?: string;
    effort?: string;
    thinking?: boolean;
    fast?: boolean;
    // Automatic-tier state the registry keeps per conversation: last verdict, and the standing veto.
    tier?: "fast" | "standard";
    tierHold?: boolean;
    // Whether the fleet actually knows this agent; false only for the board's client-only draft card.
    registered?: boolean;
}

export const agentTabOf = (agent: AgentTabSeed): StoredTab => {
    const registered = agent.registered ?? true;
    return {
        conversationId: agent.id,
        // A registered agent's isolation follows its branch; a draft keeps the fresh-conversation default of isolated.
        isolated: registered ? agent.branch !== undefined : true,
        registered,
        // The tab's address; carried through the same fold everywhere, so a summoned remote tab reaches the same
        // daemon.
        box: agent.sandboxId,
        provider: agent.provider,
        harness: agent.harness,
        account: agent.account,
        model: agent.model,
        effort: agent.effort,
        thinking: agent.thinking,
        fast: agent.fast,
        tier: agent.tier,
        tierHold: agent.tierHold,
        title: agent.title,
        // `agent.account` serves both fields but means two things: as the tab's pick, where the next turn goes; on the
        // session, what the last one actually ran under. They start equal; a switch afterward moves only the pick.
        session:
            agent.sessionId === undefined
                ? undefined
                : { id: agent.sessionId, provider: agent.provider, harness: agent.harness, account: agent.account },
        draft: ``,
        attachments: [],
        queued: [],
    };
};

// Opens or focuses the tab bound to a fleet agent's conversationId in this window. Panel-internal surfaces call it
// directly; surfaces outside the panel summon instead, applying the same fold in every window.
export const openAgentConversation = (agent: AgentTabSeed): Conversation =>
    reveal({ verb: `focus`, entries: [agentTabOf(agent)], focus: agent.id, caret: false }) ?? active.value;

// The conversation "New agent" summons: the untouched draft already open, if any (at most one), else a fresh one.
// Handing back the existing draft, rather than minting a twin, keeps a second press from reading as a no-op.
export const draftConversation = (): Conversation => {
    // Only looks in a window actually drawing the chat: a window not drawing it holds a shadow copy of the strip that
    // can't tell an untouched draft from one being typed elsewhere, since typing is never broadcast. A non-drawing
    // window always mints fresh instead.
    const open = drawsChat.value ? conversations.value.find(untouchedDraft) : undefined;
    if (open === undefined) {
        return new Conversation();
    }
    // Re-seeds the handed-back draft with current picks, so it matches what a fresh one would have been; safe since the
    // draft is untouched by definition.
    open.seedPicks();
    // A blank the panel was only standing on has no board card; a New agent press on it turns it into a chat the user
    // actually started.
    open.standIn.value = false;
    return open;
};

// The conversation a suggestion is written into. Looser than `untouchedDraft`: only requires nothing sent yet on the
// focused chat (no transcript, no session, not on the fleet), else a suggestion opens its own draft.
export const composingConversation = (): Conversation => {
    const focused = active.value;
    return !focused.registered.value && focused.messages.value.length === 0 && focused.session.value === undefined ? focused : draftConversation();
};

// Opens a past conversation from the panel's own history rows, focusing an existing tab on that session or loading a
// fresh one; panel-internal only, unlike summon.ts. Marked as a peek, like a fleet-card click.
export const openConversation = (id: string): void => {
    const conversationId = uuid();
    reveal({
        verb: `focus`,
        entries: [{ conversationId, sessionRef: id, title: sessions.value.find((session) => session.id === id)?.title }],
        focus: conversationId,
        caret: false,
        peek: true,
    });
};
