import {
    type AgentCommand,
    type AgentHarness,
    type AgentProvider,
    type EditorContext,
    endpointIdOf,
    endpointProvider,
    isTrialProvider,
    type KeyedProvider,
    type MatchSnippet,
    type Model,
    NATIVE_PROVIDERS,
    type OauthAccount,
    type PermissionMode,
    providerLabel,
    type ProviderRefusals,
    type RestoredMessage,
    TRIAL_LABEL,
    type TranslatorAccounts,
    type TrialStatusResponse,
    type UsageAccount,
} from "@intentic/sandbox-contract";
import { computed, type ComputedRef, inject, type InjectionKey, ref, shallowRef, watch } from "vue";
import { agentTranscript, type AgentTranscript } from "./agentTranscript";
import { traceFocus } from "./focusTrace";
import { Conversation, type PendingAttachment } from "./conversation";
import { accountsLoaded, providerAccounts, providerRefusals, rememberedAccountFor, selectedAccountId, translatorAccounts } from "./providerAccounts";
import {
    acpProviders,
    type CatalogLoadState,
    endpointProviders,
    type ModelOption,
    perProvider,
    providerCommands,
    providerDefaultModel,
    providerModels,
    providerModelsState,
    trialStatus,
} from "./providerCatalog";
import { rememberedModelFor, startingMode, turnDefaults } from "./turnDefaults";
import { providerReady } from "./access";
import { type ChatAttachment, type ChatMessage } from "./transcript";
import { readAccountPreference, writeAccountPreference } from "./accountPreference";
import { readTabSnapshot, type StoredTab, writeTabSnapshot } from "./tabSnapshot";
import { dropTranscript } from "./transcriptCache";
import { usageStatusByAccount } from "./usageStatus";
import { track } from "../analytics";
import { withConcurrency } from "../concurrency";
import { sandboxJson, sandboxRequest } from "../sandbox/sandboxClient";
import { jsonBody } from "../sandbox/jsonBody";
import { useSandbox } from "../sandbox/useSandbox";
import { errorMessage } from "../useAsyncAction";

// One past conversation in the sandbox's SDK session store, for the history menu.
export interface ChatSession {
    readonly id: string;
    readonly title: string;
    readonly updatedAt: number;
    // Why a searched row matched: the line the query hit, and which side of the chat said it. Absent on an
    // unfiltered list, and on a title match — the row already shows the title, so repeating it is noise.
    readonly snippet?: MatchSnippet;
}

/* Manages the shared Claude Code chat as a module-level singleton: a set of concurrent conversations (the
 * tabs), plus the global account connection and turn preferences. A singleton
 * so the open conversations survive navigation between workspace areas (the chat panel lives in the
 * persistent shell). Each Conversation owns its own stream, so a background tab keeps generating while the
 * user views another. */

const { activeSandboxId, reachable } = useSandbox();

// Open conversations (tabs) and which one is focused; always at least one. A tab IS its conversation, so the
// focus is a conversationId — the one identity the daemon, the fleet registry, the transcript mirror and the
// agent fleet registry and transcript mirror all already key on. There is deliberately no second, tab-local
// id: the previous one was minted from a counter that resetChat rewound, so a reused value silently aliased two
// different chats in anything that outlived the reset.
// shallowRef, not ref: a deep ref would unwrap each Conversation's internal Vue refs (messages, title, …)
// and mangle the class type. The instances' own refs stay reactive; reassigning the array triggers updates.
const conversations = shallowRef<Conversation[]>([]);
const activeId = ref<string>(``);

/* An untouched "New agent" tab exists only while the focus is ON it. The tab and the fleet board's draft card
 * are one conversation under two skins, so an abandoned empty draft doesn't just crowd the strip — it squats in
 * the board's Active lane looking like work in flight. Anything at all in it makes it real and it stays:
 * anything unsent (Conversation.unsent — composer text, a staged attachment, a queued message), a transcript,
 * a session, a running turn, a rename, an unread error, or a fleet registration. */
const untouchedDraft = (conversation: Conversation): boolean =>
    !conversation.registered.value &&
    !conversation.streaming.value &&
    !conversation.unsent.value &&
    conversation.messages.value.length === 0 &&
    conversation.session.value === undefined &&
    conversation.title.value === null &&
    conversation.error.value === null;

/* The one writer of the tab list AND of the focus (setActive routes through it too), holding both of the
 * strip's invariants in the same write:
 *   · the focus lands on a tab that is actually in the list, and on the LAST one when the tab that had it is
 *     gone (VSCode behaviour, the rule the workspace's tabs follow too). A focus naming nothing is invisible
 *     rather than loud — the strip highlights no tab while the panel quietly shows the first one, so every
 *     click afterwards looks like it did nothing.
 *   · at most ONE untouched draft is open, and only as the focused tab.
 *
 * The draft rule is enforced HERE rather than by a watcher reacting to the focus afterwards, which is what it
 * used to be. Reaping after the fact meant the outcome of an explicit action was decided by an implicit reaper
 * racing it: "New agent" pressed while sitting on an empty draft appended one and the reaper closed the other,
 * so the press was a visual no-op — and every intermediate state (a focus already moved, the doomed draft still
 * listed) was live long enough to render and to be persisted by the snapshot watch. It also only ever looked at
 * the tab that LOST the focus, so a draft that lost it to a list rewrite instead (a close reseating the focus on
 * the last tab) survived as a permanent, unsweepable "New agent" tab. One synchronous write, no ordering. */
const setConversations = (next: readonly Conversation[], focus: string, reason: string): void => {
    /* Where the focus lands when the id asked for names no tab in the list being written — a close taking the
     * tab that had it. A chat still ON SCREEN wins over the strip's last tab: with several panes open, closing
     * the focused one should hand the keyboard to a column the user is already looking at and let that column
     * go, rather than pull an unrelated chat into the vacated slot to hold a focus that had nowhere else to be
     * (VSCode closes the group with its last editor; this is the same move). With one pane the only pane IS the
     * closed tab, so this falls through to the last tab exactly as it always has. */
    const focused = next.some((conversation) => conversation.conversationId === focus)
        ? focus
        : (panes.value.find((id) => next.some((conversation) => conversation.conversationId === id)) ?? next[next.length - 1]!.conversationId);
    // The focused tab is always kept, so the list can never come out empty. A dropped draft needs no teardown:
    // untouched means no turn to detach from and no transcript to evict.
    const kept = next.filter((conversation) => conversation.conversationId === focused || !untouchedDraft(conversation));
    /* Every movement of the focus, with what asked for it and what it resolved to — see focusTrace.ts. The
     * FALLBACK is the line worth having: an id that names no tab in the list being written is not an error
     * here, it silently seats the focus on the last one instead, which on screen is indistinguishable from
     * "the chat ignored my click and went somewhere else" — the report this trace exists to settle. Only
     * actual movements are traced; a write that leaves the focus where it was says nothing. */
    if (focused !== activeId.value || focus !== focused) {
        traceFocus(`focus`, {
            reason,
            asked: focus,
            resolved: focused,
            ...(focus === focused ? {} : { fellBack: true }),
            from: activeId.value,
            tabs: kept.length,
            ...(kept.length === next.length ? {} : { swept: next.length - kept.length }),
        });
    }
    // Reassigned only when the list actually moved, so a plain tab switch doesn't re-fire every list watcher
    // (the snapshot write, the hydrate sweep) for a change that is only about the focus.
    if (kept.length !== conversations.value.length || kept.some((conversation, at) => conversation !== conversations.value[at])) {
        conversations.value = kept;
    }
    // Before the focus moves, since which COLUMN the incoming chat lands in is answered by where the focus is
    // leaving from.
    reconcilePanes(kept, focused);
    activeId.value = focused;
};

/* WHICH CHATS ARE ON SCREEN AT ONCE — the panes, in the order they were opened.
 *
 * One id is the ordinary case (the docked column has room for nothing else); several is the popped-out window
 * showing a fleet side by side. The focused pane is `activeId`, always a member, so every surface outside this
 * panel goes on reading `active` and means "the chat the user is looking at".
 *
 * ORDER IS INSERTION ORDER, never the rail's. The rail sorts by lane (attention / active / finished), so a
 * chat changes rows the moment its turn ends — and panes laid out in rail order would swap columns under the
 * reader's eyes mid-answer. A pane holds its column from the moment it opens until it closes. */
const panes = ref<string[]>([]);

/* The pane invariants, held in the same write as the focus and the tab list: every pane names an open tab, the
 * focused chat is always in one, and the set is never empty.
 *
 * The slot rule below is what keeps every existing caller working: a plain tab click, a card on the board, a
 * deep link and a history row all land on setActive, and none of them means "open another pane" — they mean
 * "show me this chat", so the incoming chat takes the column the focus was already in and the other panes are
 * left alone. Opening a pane is a separate verb (openBeside / setPanes), and so is closing the rest
 * (collapsePanes) — which is why a CLICK on a row or a card collapses while an arriving deep link does not:
 * one is a gesture on a selection, the other is an arrival. */
const reconcilePanes = (kept: readonly Conversation[], focused: string): void => {
    const open = new Set(kept.map((conversation) => conversation.conversationId));
    const held = panes.value.filter((id) => open.has(id));
    if (!held.includes(focused)) {
        const slot = held.indexOf(activeId.value);
        if (slot === -1) {
            held.push(focused);
        } else {
            held[slot] = focused;
        }
    }
    if (held.length !== panes.value.length || held.some((id, at) => id !== panes.value[at])) {
        panes.value = held;
    }
};

// The focused conversation. The find always hits — setConversations reconciles the focus with every list it
// writes — and list[0] is the floor that keeps a slip a wrong tab rather than a crashed panel.
const active = computed<Conversation>(() => {
    const list = conversations.value;
    return list.find((conversation) => conversation.conversationId === activeId.value) ?? list[0]!;
});

// --- Tab persistence ---------------------------------------------------------------------------
// The snapshot's shape, storage and validation live in tabSnapshot.ts; what stays here is when it is read and
// written. Which SANDBOX the open tabs belong to is recorded at restore rather than read live at write time:
// activeSandboxId flips one flush before sandboxScope's watch re-scopes the list, so a snapshot that lands in
// the incoming sandbox's key during that window is the OUTGOING sandbox's tabs — restored, on the very next
// line, as if they were the new sandbox's own.
let scopedSandboxId: string | undefined;

// One persisted tab, back as a live conversation. Restored attachments carry upload metadata only (no
// previewUrl/controller — those are client-session objects); the chip falls back to the file icon.
const restoreTab = (tab: StoredTab): Conversation => {
    const conversation = new Conversation(tab.conversationId);
    conversation.isolated.value = tab.isolated;
    conversation.registered.value = tab.registered;
    // The posture isn't part of the snapshot (it is a per-task choice, not a preference) — a restored tab
    // starts from the mode its tree calls for, same as a fresh one.
    conversation.modePick.value = startingMode(conversation.isolated.value);
    conversation.draft.value = tab.draft;
    conversation.attachments.value = tab.attachments.map((file) => ({
        id: crypto.randomUUID(),
        name: file.name,
        path: file.path,
        status: `done` as const,
        progress: 1,
    }));
    conversation.queued.value = tab.queued.map((message) => ({ id: crypto.randomUUID(), text: message.text, attachments: message.attachments }));
    conversation.title.value = tab.title ?? null;
    // Restore the harness before the model — the native/claude-code model lists diverge for codex/grok.
    if (tab.harness !== undefined) {
        conversation.harness.value = tab.harness;
    }
    if (tab.provider !== undefined) {
        conversation.provider.value = tab.provider;
        // An OPEN chat comes back on the account it was running on, not on whatever the remembered pick has since
        // become — switching one tab's account is not an instruction about the others. Only a tab that carries no
        // pin of its own (one persisted before this was stored) falls back to the provider's remembered one.
        conversation.account.value = tab.account ?? rememberedAccountFor(tab.provider);
        conversation.model.value = tab.model ?? rememberedModelFor(tab.provider);
    }
    // ...and the rest of the tab's turn settings by the same rule: the composer's pills describe THIS chat, so a
    // reload restores what it was showing rather than re-seeding it from picks made in some other tab since.
    if (tab.thinking !== undefined) {
        conversation.thinking.value = tab.thinking;
    }
    if (tab.fast !== undefined) {
        conversation.fast.value = tab.fast;
    }
    if (tab.effort !== undefined) {
        conversation.effortPick.value = tab.effort;
    }
    if (tab.session !== undefined) {
        // A session resumes only on the account that minted it, so it keeps its OWN pin rather than adopting the
        // tab's: forging the match would resume another account's session, and faking a mismatch would retire a
        // live one at the next send. Its harness moves with the tab.
        conversation.session.value = {
            ...tab.session,
            account: tab.session.account ?? rememberedAccountFor(tab.session.provider),
            harness: conversation.harness.value,
        };
    }
    return conversation;
};

// Rebuild this window's tab set for the active sandbox — its own snapshot, the last window's as a seed, or a
// single fresh tab when neither exists — and focus the stored active tab.
const restoreTabs = (): void => {
    scopedSandboxId = activeSandboxId.value;
    // Read BEFORE the tabs are built, because building one resolves an account: a fresh conversation seeds from
    // this pick (Conversation's constructor), and a restored one falls back to it. Scoped with the tabs — the
    // ids name credentials in THIS sandbox's store, so the incoming sandbox's picks replace the outgoing one's
    // rather than being cleared to nothing.
    selectedAccountId.value = readAccountPreference(scopedSandboxId);
    const stored = readTabSnapshot(scopedSandboxId);
    // The list is about to be REPLACED wholesale, focus included: the snapshot's active tab wins over whatever
    // is on screen. Rare (a sandbox switch, a boot) and invisible when it isn't — hence the line.
    traceFocus(`restore-tabs`, { sandbox: scopedSandboxId ?? `none`, stored: stored?.tabs.length ?? 0, active: stored?.active ?? `none` });
    if (stored === undefined) {
        const conversation = new Conversation();
        setConversations([conversation], conversation.conversationId, `first-tab`);
        return;
    }
    // `stored.active` names one of the tabs — the reader guarantees it.
    setConversations(stored.tabs.map(restoreTab), stored.active, `restore-snapshot`);
    /* The pane set comes back with the tabs: how this window is laid out is a decision the user made, and a
     * reload is not a decision to collapse it back to one chat. Assigned rather than run through setPanes,
     * which is the only caller with an authoritative ORDER — the columns come back where they were left.
     * Filtered against what actually restored, since the write above sweeps an untouched draft and a pane
     * naming one would be a column with nothing in it. */
    const restored = new Set(conversations.value.map((conversation) => conversation.conversationId));
    const held = stored.panes.filter((id) => restored.has(id));
    panes.value = held.length > 0 ? held : [activeId.value];
};

restoreTabs();

// Persist the tab snapshot on any change: the stringified getter touches every persisted field, so tab
// open/close/switch, keystrokes, uploads finishing, and session commits all write through automatically.
// ponytail: writes per keystroke; the blob is tiny — throttle if profiling shows jank.
watch(
    () =>
        JSON.stringify({
            active: activeId.value,
            panes: panes.value,
            tabs: conversations.value.map((conversation) => ({
                // JSON.stringify drops undefined keys, matching StoredTab's optional fields.
                conversationId: conversation.conversationId,
                isolated: conversation.isolated.value,
                registered: conversation.registered.value,
                provider: conversation.provider.value,
                account: conversation.account.value,
                model: conversation.model.value,
                effort: conversation.effortPick.value,
                thinking: conversation.thinking.value,
                fast: conversation.fast.value,
                harness: conversation.harness.value,
                session: conversation.session.value && {
                    id: conversation.session.value.id,
                    provider: conversation.session.value.provider,
                    account: conversation.session.value.account,
                },
                title: conversation.title.value ?? undefined,
                draft: conversation.draft.value,
                attachments: conversation.attachments.value
                    .filter((file) => file.status === `done`)
                    .map((file) => ({ name: file.name, path: file.path })),
                queued: conversation.queued.value.map((message) => ({
                    text: message.text,
                    attachments: message.attachments.map((file) => ({ name: file.name, path: file.path })),
                })),
            })),
        }),
    (json) => {
        if (scopedSandboxId !== undefined) {
            writeTabSnapshot(scopedSandboxId, json);
        }
    },
);

// Persist the account pick per provider — the seed a NEW conversation (and a fresh window) starts from. A watch
// rather than a write inside selectAccount, because the pick also moves on its own: a connect makes the new
// account current, a disconnect hands the selection to whatever is left, and a landing account list corrects a
// pick that is no longer valid. All of those are the user's "last preference" just as much as a click is.
watch(selectedAccountId, (picks) => {
    if (scopedSandboxId !== undefined) {
        writeAccountPreference(scopedSandboxId, picks);
    }
});

/* A READ whose failure is not news: apply what the daemon sent, and on any failure leave the ref holding
 * whatever it had. Four surfaces here work this way — slash commands, per-account usage, the routed-provider
 * listing, the refusal history — and every one of them is an ANNOTATION on a panel that has its own reason to
 * render. A daemon blip must leave them showing their last reading, never blank them or surface an error the
 * user cannot act on; the connection state itself is reported by the surfaces that own it.
 *
 * The alternative each caller wrote before this was its own try/catch with its own comment saying the same
 * thing, which is four places for that rule to be decided differently. */
const readOrKeep = async <T>(path: string, apply: (body: T) => void): Promise<void> => {
    try {
        apply(await sandboxJson<T>(path));
    } catch {
        // Left as it was — see above.
    }
};

// Load a provider's daemon-published slash commands into the shared record. Cheap (a cached in-memory read
// daemon-side), so it rides the same reachable seam as the account/model catalogs.
const loadProviderCommands = (target: AgentProvider): Promise<void> =>
    readOrKeep<{ commands: AgentCommand[] }>(`/agent/commands?agent=${encodeURIComponent(target)}`, (body) => {
        providerCommands.value = { ...providerCommands.value, [target]: body.commands };
    });

// Past conversations from the sandbox's session store, loaded on demand for the history menu.
const sessions = ref<ChatSession[]>([]);

/* ONE CONVERSATION, AS A PANEL BINDS IT — the facade every chat surface renders through, over whichever
 * conversation it was built for rather than over the focused one.
 *
 * It exists as a FACTORY because the chat panel shows several conversations at once (the pop-out's panes): a
 * transcript, its composer, its pickers and its tool cards all have to answer for the chat they are IN, and a
 * module-level facade over `active` can only ever answer for the focused one. The singleton below builds its
 * own from `active`, so the store's exported surface — and every consumer outside the panel — is unchanged;
 * a pane builds one over its own conversation and is right by construction.
 *
 * Everything here is a computed or a function, so the factory can be called before the module bindings it
 * closes over (chatReady, setConversations, loadProviderModels) are initialized: nothing is dereferenced until
 * a surface reads it. */
export const conversationView = (conversation: ComputedRef<Conversation>) => ({
    conversation,
    messages: computed(() => conversation.value.messages.value),
    streaming: computed(() => conversation.value.streaming.value),
    // This conversation's slash commands: the list its own turns published (authoritative — it reflects the
    // session's live config), falling back to the provider's last daemon-published list so a conversation that
    // hasn't run a turn yet still has a populated `/` popover.
    availableCommands: computed<readonly AgentCommand[]>(() => {
        const own = conversation.value.availableCommands.value;
        return own.length > 0 ? own : (providerCommands.value[conversation.value.provider.value] ?? []);
    }),
    awaitingDecision: computed(() => conversation.value.awaitingDecision.value),
    pendingPlanMessage: computed(() => conversation.value.pendingPlanMessage.value),
    // This conversation's undelivered messages (submitted while its turn was running) and whether its running
    // turn can take one mid-flight — the composer renders the first and words its hints from the second.
    queued: computed(() => conversation.value.queued.value),
    removeQueued: (id: string): void => conversation.value.removeQueued(id),
    steerable: computed(() => conversation.value.steerable.value),
    // What this conversation's runtime can do (the contract's declared record) — the composer reads it to
    // offer only the controls something applies, and to say what this provider can't do at all.
    capabilities: computed(() => conversation.value.capabilities.value),
    activeModel: computed(() => conversation.value.activeModel.value),
    contextUsage: computed(() => conversation.value.contextUsage.value),
    // This conversation's permission mode (read + write) — the composer's mode pill drives it. Reads the
    // RUNNING turn's posture while one is live (the agent can enter plan mode on its own, and the pill must not
    // claim otherwise); a pick replaces it, because from that click on the user's choice is the truth. Not
    // written through to the persisted defaults: the posture belongs to the conversation, not to the next one.
    mode: computed<PermissionMode>({
        get: () => conversation.value.liveMode.value ?? conversation.value.mode.value,
        set: (value) => {
            conversation.value.modePick.value = value;
            conversation.value.liveMode.value = undefined;
        },
    }),
    // Turn settings (read+write) — the composer binds these, so switching tabs shows that chat's
    // provider/model/effort/thinking. All of it is switchable mid-chat: a provider/account switch takes effect
    // at the next send (see Conversation.send's segment cut).
    provider: computed<AgentProvider>(() => conversation.value.provider.value),
    selectProvider: (p: AgentProvider): void => {
        conversation.value.selectProvider(p);
        // The catalog is daemon-owned and can be stale (loaded before the account connected, or an empty
        // transient) — refetch on landing so the model picker is populated on arrival (the daemon caches, so
        // this is cheap).
        void loadProviderModels(p);
    },
    // The harness (Default = the provider's native runtime, vs the Claude Code loop). Only meaningful for
    // codex/grok; picked through the model picker's footer chips. A switch retires the session at the next send.
    harness: computed<AgentHarness>(() => conversation.value.harness.value),
    // Switch the harness — an axis orthogonal to the model now (the catalog is shared, so the chosen model
    // rides across). No-ops on claude (always its own loop) and mid-stream (selectHarness guards both).
    selectHarness: (next: AgentHarness): void => conversation.value.selectHarness(next),
    model: computed<string>({
        get: () => conversation.value.model.value,
        set: (value) => conversation.value.selectModel({ provider: conversation.value.provider.value, value }),
    }),
    // Conversation.selectModel is the whole rule (provider re-point, per-provider memory, the mid-stream
    // guard); what this adds is the catalog refetch, which only a surface that did not open the picker needs —
    // the picker warms every catalog on mount and so drives the conversation directly.
    selectModel: (pick: { provider: AgentProvider; value: string }): void => {
        conversation.value.selectModel(pick);
        void loadProviderModels(pick.provider);
    },
    // The effort the composer shows is the EFFECTIVE one (the pick clamped to the current model's scale);
    // setting it records a new pick, on this conversation and as the seed for the next new chat.
    effort: computed<string>({
        get: () => conversation.value.effort.value,
        set: (value) => conversation.value.setEffort(value),
    }),
    thinking: computed<boolean>({
        get: () => conversation.value.thinking.value,
        set: (value) => conversation.value.setThinking(value),
    }),
    // Fast speed: the pick, whether the control is offered at all for the current provider/model, and what the
    // last turn actually ran at. Three values rather than one because they answer different questions — what
    // the user asked for, whether asking is even possible here, and what came back.
    fast: computed<boolean>({
        get: () => conversation.value.fast.value,
        set: (value) => conversation.value.setFast(value),
    }),
    fastOffered: computed<boolean>(() => conversation.value.fastOffered.value),
    fastMode: computed(() => conversation.value.fastMode.value),
    // Account facades: this conversation's account selection + the connected accounts of its provider, for the
    // composer switcher.
    account: computed<string | undefined>(() => conversation.value.account.value),
    selectAccount: (id: string): void => conversation.value.selectAccount(id),
    accounts: computed<readonly OauthAccount[]>(() => accountsOf(conversation.value.provider.value)),
    // Whether this conversation's selection can actually send — the composer gate.
    connected: computed(() => chatReady(conversation.value.provider.value, conversation.value.harness.value)),
    // This conversation's composer draft (text + staged attachments) — per-tab, so switching tabs swaps the
    // composer back to whatever was typed and attached there.
    draft: computed<string>({
        get: () => conversation.value.draft.value,
        set: (value) => {
            conversation.value.draft.value = value;
        },
    }),
    attachments: computed<PendingAttachment[]>({
        get: () => conversation.value.attachments.value,
        set: (value) => {
            conversation.value.attachments.value = value;
        },
    }),
    send: (prompt: string, staged?: readonly ChatAttachment[], editorContext?: EditorContext): Promise<void> => {
        // Core funnel milestone (autocapture misses Enter-key sends); PostHog derives "first message" per person.
        track(`message_sent`, { agent: conversation.value.provider.value, queued: conversation.value.streaming.value });
        return conversation.value.enqueue(prompt, staged, editorContext);
    },
    stop: (): void => {
        conversation.value.stop();
    },
    /* FORK THE CONVERSATION AT A CUT — everything above the cut is copied into a fresh tab, and the source is
     * left completely alone, so the answer being replaced is still there to compare against and nothing is
     * destroyed by an experiment.
     *
     * `cut` is the index of the first message BELOW the line, which is the one number the whole affordance turns
     * on: it is how many bubbles the fork inherits, and it is also what decides what the composer opens with.
     * A cut above a user message means "redo this turn differently", so that prompt (and its attachments) is
     * loaded into the composer ready to be edited — the fork of the whole conversation, cut past the last
     * message, opens with an empty one instead.
     *
     * NOTHING IS SENT. The fork opens with the prompt sitting in the composer where the user can read it, change
     * it, or replace it entirely — which is what makes forking without editing possible at all, and what stops a
     * half-considered prompt from running the moment the tab appears. The old edit-then-auto-send did the
     * opposite on both counts. */
    forkAt: (cut: number, files: "then" | "now"): void => {
        const source = conversation.value;
        if (cut < 0 || cut > source.messages.value.length) {
            return;
        }
        /* A RUNNING TURN DOES NOT BLOCK THE CHAT HALF OF THIS. Copying the turns above the cut into a new tab
         * takes nothing away from the run still writing below it, and a turn that has been going twenty
         * minutes is exactly when a second line of attack is worth opening — refusing then made the control
         * useless at the one moment it was wanted. What a running turn does block is the FILES: putting a
         * checkpoint back underneath an agent writing to those same files is a different act, so that half
         * waits for the turn to end. */
        if (files === `then` && source.streaming.value) {
            return;
        }
        const fork = new Conversation();
        fork.forkFrom(source, cut, files);
        // The message the cut sits above, when it is one of the user's: the fork opens holding it, so "fork and
        // ask it differently" is one gesture rather than a fork followed by a hunt for what was said.
        const below = source.messages.value[cut];
        if (below?.role === `user`) {
            fork.draft.value = below.text;
        }
        setConversations([...conversations.value, fork], fork.conversationId, `fork`);
        track(`conversation_forked`, { agent: fork.provider.value, files, whole: cut === source.messages.value.length });
    },
    // Approving runs the plan (under bypassPermissions — the daemon's call, not the card's); a rejection leaves
    // the agent in plan mode to revise, with the composer's text and staged files as the feedback.
    decidePlan: (message: ChatMessage, approve: boolean, feedback?: string, staged?: readonly ChatAttachment[]): Promise<void> =>
        conversation.value.decidePlan(message, approve, feedback, staged),
    answerQuestion: (message: ChatMessage, answers: Record<string, string[]>): Promise<void> => conversation.value.answerQuestion(message, answers),
    cancelQuestion: (message: ChatMessage): Promise<void> => conversation.value.cancelQuestion(message),
    decidePermission: (message: ChatMessage, decision: "once" | "always" | "deny", feedback?: string): Promise<void> =>
        conversation.value.decidePermission(message, decision, feedback),
    // "Can't help now" for a browser-help card; "hand back" lives on /browsers, beside the live stage.
    declineBrowserHelp: (message: ChatMessage): Promise<void> => conversation.value.declineBrowserHelp(message),
});

export type ConversationView = ReturnType<typeof conversationView>;

/* THE PANE'S VIEW, for the surfaces under it — the transcript rows, their tool cards, the mode menu, the
 * account panel. Injected rather than threaded through four levels of props, and it is the pane's OWN view:
 * a tool card in the right-hand pane must answer for the chat it is in, not for whichever one has the focus.
 * Absent means the component was mounted outside a pane, which is a wiring mistake rather than a state to
 * render — so it is discovered at mount instead of silently rendering the focused chat's content. */
export const PANE_VIEW: InjectionKey<ConversationView> = Symbol(`chat-pane-view`);
export const usePaneView = (): ConversationView => {
    const view = inject(PANE_VIEW);
    if (view === undefined) {
        throw new Error(`a chat surface was mounted outside a ChatPane`);
    }
    return view;
};

// The focused conversation's view — what the store itself binds, and what every surface outside the chat panel
// reads through `useChat()`.
const activeView = conversationView(active);
const {
    messages,
    streaming,
    availableCommands,
    awaitingDecision,
    pendingPlanMessage,
    queued,
    removeQueued,
    steerable,
    capabilities,
    activeModel,
    contextUsage,
    mode,
    provider,
    selectProvider,
    harness,
    selectHarness,
    model,
    selectModel,
    effort,
    thinking,
    fast,
    fastOffered,
    fastMode,
    account,
    selectAccount,
    accounts,
    connected,
    draft,
    attachments,
    send,
    stop,
    forkAt,
    decidePlan,
    answerQuestion,
    cancelQuestion,
    decidePermission,
} = activeView;

// Providers are an open string vocabulary — an unseeded key (an ACP agent, which owns its own credentials)
// simply has no daemon account list.
export const accountsOf = (target: AgentProvider): readonly OauthAccount[] => providerAccounts.value[target] ?? [];
// The manage card's accounts, which follow the card's own provider rather than any conversation's.
const managedAccounts = computed<readonly OauthAccount[]>(() => accountsOf(managedProvider.value));

// The route prefix a provider's ACCOUNT routes live under — and only Claude and Grok have any. Every other
// provider authenticates through the subscription the translator holds, which is why refreshConnections filters
// them out (subscriptionOnly) before anything here is reached.
// Catalogs are deliberately NOT here: they are the one question every provider answers identically, so they
// come off a single parameterized route (modelsPath below).
const providerBase = (p: AgentProvider): string => (p === `grok` ? `/grok` : `/claude`);

// Where a provider's model catalog is read from. Two shapes, because there are two kinds of subject: a native
// provider is one of a closed set the daemon holds a catalog for, so it rides the shared route as a parameter;
// an endpoint is a capability the user created, so its id names the one route configured for it.
const modelsPath = (p: AgentProvider): string => {
    const endpointId = endpointIdOf(p);
    return endpointId !== undefined ? `/endpoints/${encodeURIComponent(endpointId)}/models` : `/providers/${encodeURIComponent(p)}/models`;
};
// Providers whose ONLY credential is the translator subscription: they have no native account handshake, so the
// card shows the routed row alone and there is nothing for `startConnect` to arm. Grok is deliberately absent —
// it has both a native xAI account and a routed subscription, and which one gates depends on the harness.
// The providers with no account of their own: their turns authenticate through a subscription the bundled
// translator holds, which is why they have no row in an account picker — CLIProxyAPI balances across every
// auth file it has, so WHICH one serves a turn is not a choice anyone makes.
export const subscriptionOnly = (p: AgentProvider): p is "codex" | "kimi" | "gemini" => p === `codex` || p === `kimi` || p === `gemini`;

// Which account the manage/connect card acts on — decoupled from the chat-turn provider so connecting or
// disconnecting one account never mutates the active conversation's provider.
const managedProvider = ref<AgentProvider>(turnDefaults.provider.value);

// Per-account token/cost totals (from the daemon's /system/usage aggregation of the activity log), keyed by
// account id. Loaded when the manage card opens; empty until then.
const accountUsage = ref<Record<string, UsageAccount>>({});
const loadUsage = (): Promise<void> =>
    readOrKeep<{ accounts: UsageAccount[] }>(`/system/usage`, (body) => {
        accountUsage.value = Object.fromEntries(body.accounts.map((usage) => [usage.account, usage]));
    });

/* Point the account card at a provider. That is ALL it does, and the emptiness is the point.
 *
 * It used to fire a connect handshake by itself whenever the card landed on an account-less native provider,
 * which is what made the switcher flicker: the row painted its "Connect" button, the /oauth/start round-trip
 * landed a moment later, and the button was yanked out from under the pointer and replaced by a device code
 * nobody had asked for. It also meant merely LOOKING at a provider minted a one-time code and started a
 * 15-minute poll, and it did so for three of the five tabs — the two that authenticate through the translator
 * never armed anything, so the same click did two different things depending on which chip it hit.
 *
 * Browsing is browsing: every provider now shows its state and waits to be asked (startConnect /
 * connectTranslator, from the row's own button). A live handshake is deliberately NOT cancelled here either —
 * both flows carry the provider they belong to, so a sign-in the user is completing at x.ai survives a look at
 * another tab instead of being silently killed by it. */
const setManagedProvider = (target: AgentProvider): void => {
    managedProvider.value = target;
};

// --- Routed-provider subscriptions --------------------------------------------------------------
// The sandbox's translator (CLIProxyAPI) serves Codex/Grok/Kimi/Google models to the Claude Code harness on the
// user's subscription OAuth — a credential of its own, separate from a provider's native-harness
// account (each program owns and refreshes its own grant; a shared refresh token would rotate out from under
// one of them). The connection state itself lives in conversation.ts beside providerAccounts (so access.ts can
// derive from both without a cycle); what stays here is the login flow it is driven by — held outside
// SandboxAgent so a device-login poll survives that tab unmounting.
// The in-flight subscription login the Agent tab's routed row shows. Device flows may carry a one-time `code`;
// redirect flows ask the user to paste the URL they landed on and `completeTranslator` finishes it against
// `state`. `baseline` is how many accounts
// the provider held when the login started — a provider can hold several, so "connected" is the count GROWING
// past it, not the provider being truthy (which an "add another account" login already is from the start).
const translatorConnectFlow = ref<
    { provider: KeyedProvider; url: string; code: string; state: string; flow: "device" | "redirect"; baseline: number } | undefined
>(undefined);
/* The account write in flight right now, as the KEY of the thing being written: the provider id while a sign-in
 * is being started or finished, the account id / auth-file name while one is being dropped. One ref for both
 * mechanisms (native handshake and translator subscription alike), because it exists to answer one question the
 * card asks in one place: does THIS row's button spin?
 *
 * Keyed rather than boolean so the answer is that row's and not the whole card's — a click is acknowledged in
 * the button the user pressed, at the moment they press it, instead of by something appearing elsewhere a
 * round-trip later. Its other half is serialization: one account write at a time, which is the honest reading
 * of a card that shows one provider at a time. */
const accountBusy = ref<string | undefined>(undefined);
/* A routed row's key. Namespaced away from the provider id on purpose: under Grok the native xAI account and
 * the translator subscription are two connections of the SAME provider, sitting one above the other, and keying
 * both as `grok` made a click on either spin both their buttons. With `name`, one specific subscription (auth
 * file names are unique per provider, not across them); without it, that provider's sign-in. */
const translatorKey = (target: AgentProvider, name?: string): string => `translator:${target}${name === undefined ? `` : `:${name}`}`;
let translatorPollTimer: ReturnType<typeof setTimeout> | undefined;

const translatorProviderLabel = (target: KeyedProvider): string =>
    target === `codex` ? `ChatGPT` : target === `grok` ? `SuperGrok` : target === `kimi` ? `Kimi Code` : `Google`;

const refreshTranslatorAccounts = (): Promise<void> =>
    readOrKeep<TranslatorAccounts>(`/translator/accounts`, (listing) => {
        translatorAccounts.value = listing;
    });

// When each provider last refused a turn — the observed counterpart to the polled snapshots that ride the two
// account listings (see providerRefusals).
const refreshProviderRefusals = (): Promise<void> =>
    readOrKeep<ProviderRefusals>(`/agent/refusals`, (body) => {
        providerRefusals.value = body.refusals;
    });

// CLIProxyAPI finishes every routed login in the background — the device flows poll upstream on their own, and
// a redirect flow resumes the moment `completeTranslator` hands it the pasted URL — so in both cases the UI just
// polls the connection state until the provider flips connected, bounded by the device flows' deadline.
const pollTranslatorOnce = async (target: KeyedProvider, deadline: number): Promise<void> => {
    if (translatorConnectFlow.value?.provider !== target) {
        return;
    }
    if (Date.now() > deadline) {
        error.value = `The ${translatorProviderLabel(target)} sign-in expired — start the connection again.`;
        translatorConnectFlow.value = undefined;
        return;
    }
    await refreshTranslatorAccounts();
    const flow = translatorConnectFlow.value;
    if (flow?.provider !== target) {
        return;
    }
    if (translatorAccounts.value[target].length > flow.baseline) {
        translatorConnectFlow.value = undefined;
        error.value = null;
        return;
    }
    translatorPollTimer = setTimeout(() => void pollTranslatorOnce(target, deadline), 3_000);
};

// Start a subscription login for a routed provider: the daemon returns the sign-in URL and, for the providers
// that mint one, a one-time code. The user approves upstream and the poll flips the row to connected. One flow
// at a time — a new connect supersedes a prior one (mirroring the daemon, which kills a superseded subprocess).
const connectTranslator = async (target: KeyedProvider): Promise<void> => {
    if (accountBusy.value !== undefined) {
        return;
    }
    accountBusy.value = translatorKey(target);
    error.value = null;
    clearTimeout(translatorPollTimer);
    try {
        translatorConnectFlow.value = {
            provider: target,
            baseline: translatorAccounts.value[target].length,
            ...(await sandboxJson<{ url: string; code: string; state: string; flow: "device" | "redirect" }>(`/translator/${target}/connect`, {
                method: `POST`,
            })),
        };
        translatorPollTimer = setTimeout(() => void pollTranslatorOnce(target, Date.now() + CODEX_POLL_DEADLINE_MS), 3_000);
    } catch (caught) {
        error.value = errorMessage(caught, `Could not start the subscription connection — is your sandbox online?`);
    } finally {
        accountBusy.value = undefined;
    }
};

// Finish a redirect login by handing the daemon the URL the provider sent the browser to. Google's sign-in ends
// on a loopback address only the sandbox container binds, so the page never loads for the user — but the address
// bar still carries the grant, which is what they paste here. The translator then resumes the exchange on its
// own, so success just means "keep polling"; the row flips connected on the next poll.
const completeTranslator = async (redirectUrl: string): Promise<void> => {
    const flow = translatorConnectFlow.value;
    if (flow === undefined || flow.flow !== `redirect`) {
        return;
    }
    accountBusy.value = translatorKey(flow.provider);
    error.value = null;
    try {
        await sandboxJson(
            `/translator/${flow.provider}/complete`,
            jsonBody(`POST`, { provider: flow.provider, redirectUrl: redirectUrl.trim(), state: flow.state }),
        );
        await refreshTranslatorAccounts();
    } catch (caught) {
        error.value = errorMessage(caught, `That sign-in link could not be completed — copy the whole URL and try again.`);
    } finally {
        accountBusy.value = undefined;
    }
};

// Drop ONE of the provider's connected accounts, addressed by its translator auth-file name.
const disconnectTranslator = async (target: KeyedProvider, name: string): Promise<void> => {
    accountBusy.value = translatorKey(target, name);
    try {
        await sandboxRequest(`/translator/${target}/disconnect`, jsonBody(`POST`, { provider: target, name }));
        if (translatorConnectFlow.value?.provider === target) {
            clearTimeout(translatorPollTimer);
            translatorConnectFlow.value = undefined;
        }
        await refreshTranslatorAccounts();
    } finally {
        accountBusy.value = undefined;
    }
};

// Abandon an in-flight subscription login. Dropping the flow is enough to stop its poll (every tick returns
// early once the flow it was started for is gone), but the pending timer is cleared too so a superseded tick
// can't fire against a row the user has moved on from.
const cancelTranslatorConnect = (): void => {
    clearTimeout(translatorPollTimer);
    translatorConnectFlow.value = undefined;
};

// Account / connection (global; the sandbox or translator owns each provider's credentials). Several accounts per provider
// live in `providerAccounts` (conversation.ts module state). `error` carries connection / account errors —
// per-turn chat errors live on each Conversation. `connected` = the ACTIVE conversation's selection can send;
// `claudeConnected` = Claude specifically (the Sandbox page's card).
const error = ref<string | null>(null);
const hasAccount = (target: AgentProvider): boolean => accountsOf(target).length > 0;
// Whether a provider+harness selection can actually send — the composer gate, mirroring the daemon's own gate
// (agent.routes). Codex has no native account: it always authenticates through the translator's ChatGPT
// SUBSCRIPTION (native or under the Claude Code harness), so only that connection matters. Grok under the Claude
// Code harness likewise rides the translator subscription. Everything else needs the provider's account; an ACP
// provider is its own credential store — installed means chat-ready, so it never gates the composer.
const chatReady = (target: AgentProvider, loop: AgentHarness): boolean => {
    if (subscriptionOnly(target)) {
        return translatorAccounts.value[target].length > 0;
    }
    if (target === `grok` && loop === `claude-code`) {
        return translatorAccounts.value.grok.length > 0;
    }
    return hasAccount(target) || acpProviders.value.some((agent) => agent.id === target);
};
const claudeConnected = computed(() => hasAccount(`claude`));

// Keep the composer usable whenever ANY provider has an account: when the connection state changes (initial
// load, a connect/disconnect, a sandbox reset), point each untouched fresh conversation whose selection can't
// send at a connected provider. Started conversations (a session or visible messages) are never auto-repointed —
// that would retire their session and insert a switch notice the user didn't ask for.
watch([providerAccounts, translatorAccounts], () => {
    for (const conversation of conversations.value) {
        if (
            conversation.session.value !== undefined ||
            conversation.messages.value.length > 0 ||
            chatReady(conversation.provider.value, conversation.harness.value)
        ) {
            continue;
        }
        const fallback = NATIVE_PROVIDERS.find((p) => providerReady(p));
        if (fallback) {
            conversation.selectProvider(fallback);
        }
    }
});
/* The in-flight NATIVE sign-in (Claude / Grok), held between start and completion. It shares the fields the card
 * renders with translatorConnectFlow above; the translator's extra flow discriminator stays at that boundary.
 *
 * It carries the PROVIDER it belongs to, which is what lets a handshake outlive a look at another tab: the flow
 * unfolds under the row that started it and nowhere else, so browsing the switcher can neither smear a Grok
 * device code onto Claude's row nor force us to kill a sign-in the user is still completing at x.ai.
 *
 * `code` is the device code to approve upstream (Grok's, pre-filled at x.ai); it is empty for the flow that
 * hands the user something to paste back instead (Claude's authorization code). `pkce` is
 * Claude's verifier/state round-trip, carried to completeConnect and to nothing else. */
interface NativeConnectFlow {
    readonly provider: AgentProvider;
    readonly url: string;
    readonly code: string;
    readonly pkce?: { readonly verifier: string; readonly state: string };
}
const nativeConnectFlow = ref<NativeConnectFlow | undefined>(undefined);
// The display label the user typed for the account being connected (blank ⇒ the daemon derives one from the
// sign-in identity or a provider default). Bound by the account panel; read when a connect completes.
const connectLabel = ref(``);

// Add a freshly-connected account to its provider's list and make it the selected one.
const addAccount = (target: AgentProvider, added: OauthAccount): void => {
    const existing = accountsOf(target).filter((a) => a.id !== added.id);
    providerAccounts.value = { ...providerAccounts.value, [target]: [...existing, added] };
    selectedAccountId.value = { ...selectedAccountId.value, [target]: added.id };
    adoptStranded(target, added);
};

/* A reconnect mints a NEW account id, which leaves every chat still pinned to the old one sending against a
 * credential that no longer exists — measured in the incident this all comes from: a session kept failing for
 * a full minute AFTER the account was reconnected, purely because its tab held the dead id. Reconnecting means
 * "carry on", so the stranded chats move across and anything held for the outage goes now.
 *
 * Only chats whose account is missing or flagged for reauth move: adding a SECOND account alongside a healthy
 * one must not quietly redirect conversations away from the account the user chose for them. */
const adoptStranded = (target: AgentProvider, added: OauthAccount): void => {
    const live = accountsOf(target);
    for (const conversation of conversations.value) {
        if (conversation.provider.value !== target) {
            continue;
        }
        const current = conversation.account.value;
        if (current !== undefined && current !== added.id && !live.some((entry) => entry.id === current && entry.needsReauth !== true)) {
            conversation.rebindAccount(added.id);
        }
        void conversation.resume();
    }
};

/* adoptStranded's mirror image: conversations pinned to an account the provider's list no longer HAS, moved onto
 * the live pick. Two ways to get there — the account was disconnected in this window, or it was disconnected
 * while this window was away and the pin came back from the tab snapshot — and the same outcome either way: an
 * invisible dead pin, every turn on that chat failing with "No Claude account connected", naming a fix the user
 * has already done for an account that IS connected, because the dead id is the one thing the message can't
 * mention. `live` is the provider's current list; the pick it belongs with must already be reconciled against it.
 *
 * Rebound, not selected: the user didn't switch, their choice went away — so the session moves across with the
 * conversation and no "switched to…" divider is raised. Nothing to move to (the provider has no accounts left)
 * leaves the pin alone: the composer's connect gate is what has something to say then, not the account axis. */
const repointStranded = (target: AgentProvider, live: readonly OauthAccount[]): void => {
    const picked = selectedAccountId.value[target];
    // Where a stranded chat lands: the remembered pick when the list that just arrived still holds it, else the
    // provider's first account. Resolved against THAT list rather than through rememberedAccountFor, which
    // deliberately returns the pick unvalidated until every provider's first read has landed — moving a chat
    // onto an id this very list says is gone is the failure this function exists to prevent.
    const next = live.some((entry) => entry.id === picked) ? picked : live[0]?.id;
    if (next === undefined) {
        return;
    }
    for (const conversation of conversations.value) {
        const pin = conversation.account.value;
        if (conversation.provider.value === target && pin !== undefined && !live.some((entry) => entry.id === pin)) {
            conversation.rebindAccount(next);
        }
    }
};

// Pull a provider's account list from its daemon and keep the selection valid (first account when the current
// pick is gone). The single reader of the `/accounts` routes. THROWS when the read fails (sandboxJson): a
// daemon that didn't answer has not told us the user has no accounts, and callers that treat the two the same
// are how an empty card comes to claim "not connected" during an outage.
const refreshAccounts = async (target: AgentProvider, force: boolean): Promise<OauthAccount[]> => {
    /* `force` re-measures the plan limits before the list answers, and reaches CLAUDE ALONE because it is the
     * only list that waits on a quota sweep at all. The routed subscriptions' rings come off the daemon's own
     * background sweep and that read deliberately never blocks on upstream — it is the routed turn's credential
     * gate as much as it is a settings list, so a round-trip there would land on every routed turn's startup. */
    const forced = force && target === `claude` ? `?force=1` : ``;
    const list = (await sandboxJson<{ accounts?: OauthAccount[] }>(`${providerBase(target)}/accounts${forced}`)).accounts ?? [];
    providerAccounts.value = { ...providerAccounts.value, [target]: list };
    // Seed the shared usage map from the daemon's persisted snapshots, so a fresh page load shows each account's
    // remaining headroom immediately instead of staying blank until that account's next turn. A reading this
    // session already streamed wins when it is the newer of the two (the daemon's write is fire-and-forget, so
    // a refresh can land between the frame and its persist).
    const seeded = { ...usageStatusByAccount.value };
    for (const entry of list) {
        const persisted = entry.usage;
        if (persisted !== undefined && (seeded[entry.id]?.measuredAt ?? 0) <= persisted.measuredAt) {
            seeded[entry.id] = persisted;
        }
    }
    usageStatusByAccount.value = seeded;
    /* THE REMEMBERED PICK IS NOT REWRITTEN FROM A LIST. It used to be — a pick this answer didn't contain was
     * replaced by `list[0]`, and the watch above then PERSISTED that. Which made every list a verdict on the
     * user's choice, including the ones that are not: a 200 carrying an empty array is what a daemon serves
     * while its credential store is still coming up (the dir read fails soft, by design), and one of those was
     * enough to forget a deliberate choice for good — from then on every new session opened on the first
     * account, with nothing left anywhere to say otherwise. That is the "the account randomly switches back"
     * report.
     *
     * A stale pick costs nothing, because forgetting was never what made the app correct: every reader already
     * resolves it against the live list (rememberedAccountFor for a new conversation, repointStranded for the
     * open ones), so an id that is genuinely gone is stepped over on the way to the first account and a pick
     * that is merely unreadable this second survives to be honoured when the real list lands. It is dropped
     * only where the user actually said so — a disconnect of that exact account (disconnectAccount), or a new
     * pick (selectAccount / a connect). */
    repointStranded(target, list);
    return list;
};

// Load a provider's live model catalog from the daemon into the shared records (providerModels/
// providerDefaultModel), then keep selections valid: point any native conversation on that provider whose
// model is no longer offered — and the persisted per-provider default — back to the live default (the same
// selection-fix refreshAccounts does for accounts). Claude-Code-harness selections are translator-mapped ids,
// not catalog ids, so they're left alone (claude itself is its own loop on either harness).
const loadProviderModelsOnce = async (target: AgentProvider): Promise<void> => {
    providerModelsState.value = { ...providerModelsState.value, [target]: `loading` };
    let body: { models: Model[]; default: string };
    try {
        const response = await sandboxRequest(modelsPath(target));
        if (!response.ok) {
            providerModelsState.value = { ...providerModelsState.value, [target]: `error` };
            return;
        }
        body = (await response.json()) as { models: Model[]; default: string };
        if (!Array.isArray(body.models)) {
            providerModelsState.value = { ...providerModelsState.value, [target]: `error` };
            return;
        }
    } catch {
        // The daemon is unreachable/mid-restart; the picker shows the error row with a Retry.
        providerModelsState.value = { ...providerModelsState.value, [target]: `error` };
        return;
    }
    providerModelsState.value = { ...providerModelsState.value, [target]: `loaded` };
    // The daemon's catalog is never empty; the guard keeps us from ever pinning a selection to nothing.
    if (body.models.length === 0) {
        return;
    }
    providerModels.value = {
        ...providerModels.value,
        [target]: body.models.map((entry) => ({
            label: entry.label,
            value: entry.id,
            ...(entry.efforts !== undefined ? { efforts: entry.efforts } : {}),
            ...(entry.description !== undefined ? { description: entry.description } : {}),
            ...(entry.badges !== undefined ? { badges: entry.badges } : {}),
        })),
    };
    providerDefaultModel.value = { ...providerDefaultModel.value, [target]: body.default };
    // Every selection should carry a concrete offered id. Repoint anything empty OR no-longer-offered (a
    // since-renamed/retired id like `grok-code-fast-1`, or a tier alias once the real ids load) to the default,
    // so the picker highlights a selection and the chip always shows a name, never the bare icon. Harness-agnostic
    // now — the catalog is shared, so a claude-code codex/grok selection is validated the same as a native one.
    const valid = new Set(body.models.map((entry) => entry.id));
    for (const conversation of conversations.value) {
        if (conversation.provider.value === target && !valid.has(conversation.model.value)) {
            conversation.model.value = body.default;
        }
    }
    if (!valid.has(turnDefaults.models.value[target] ?? ``)) {
        turnDefaults.models.value = { ...turnDefaults.models.value, [target]: body.default };
    }
};

// One catalog load per provider at a time — the picker's on-open refresh, the reachable seam, and a manual
// retry all reach for the same list, and a second fetch would answer identically. Deduped by POLICY rather
// than by reading `providerModelsState` back as a mutex: that ref is what the picker RENDERS (spinner, error
// row), and using presentation state to decide whether a request may start meant a direct call while one was
// in flight duplicated the fetch, while `loaded` vs `loading` drifting for any other reason broke the dedup.
export const loadProviderModels = withConcurrency(loadProviderModelsOnce, { mode: `singleFlight`, key: (target) => target });

// Refresh every NATIVE provider's catalog — the reachable seam and the picker's on-open refresh both use this,
// so searching across providers always has all lists warm. ACP providers have no daemon catalog (the agent
// owns its own model). In-flight providers collapse into their running load, so this is safe to spam.
export const loadAllProviderModels = async (): Promise<void> => {
    await Promise.all(NATIVE_PROVIDERS.map((target) => loadProviderModels(target)));
};

// Device-code sign-in expires after 15 minutes; stop polling past it.
const CODEX_POLL_DEADLINE_MS = 15 * 60 * 1000;
let grokPollTimer: ReturnType<typeof setTimeout> | undefined;

// Drop any in-progress handshake: clear the poll timer and the connect UI state. Safe to call repeatedly.
const cancelConnect = (): void => {
    if (grokPollTimer !== undefined) {
        clearTimeout(grokPollTimer);
        grokPollTimer = undefined;
    }
    nativeConnectFlow.value = undefined;
    connectLabel.value = ``;
};

// One tick of the Grok device-flow poll: OpenCode completes the xAI token exchange on approval, so we just ask
// the sandbox whether xAI is connected yet, flipping to connected on success. Only the no-paste (device) flow
// polls; a paste-back method finishes via completeConnect instead. Supersession is checked against the flow
// OBJECT the tick was started for, so a restarted (or cancelled) handshake retires the ticks of the old one.
const pollGrokOnce = async (deadline: number): Promise<void> => {
    const flow = nativeConnectFlow.value;
    if (flow?.provider !== `grok`) {
        return;
    }
    if (Date.now() > deadline) {
        error.value = `The Grok sign-in expired — start the connection again.`;
        cancelConnect();
        return;
    }
    try {
        const grokAccounts = await refreshAccounts(`grok`, false);
        if (nativeConnectFlow.value !== flow) {
            return;
        }
        if (grokAccounts.length > 0) {
            cancelConnect();
            error.value = null;
            // The account just connected — load its model catalog now so the picker is populated immediately,
            // not only after the next reselect or reload.
            void loadProviderModels(`grok`);
            return;
        }
    } catch {
        // Transient (sandbox blip); keep polling until the deadline.
    }
    if (nativeConnectFlow.value !== flow) {
        return;
    }
    grokPollTimer = setTimeout(() => void pollGrokOnce(deadline), 3000);
};

// Reset the whole chat singleton when the active sandbox changes (see sandboxScope). Conversations, history,
// and the account-connection state all belong to the sandbox they were loaded from — carrying them onto a
// different sandbox would stream against the wrong daemon and show its "connected" status falsely.
export const resetChat = (): void => {
    for (const conversation of conversations.value) {
        conversation.abort();
    }
    /* Dropped BEFORE the tabs are rebuilt, not with the rest of the sandbox-scoped state below: restoring a tab
     * resolves its account against these, and the outgoing sandbox's list is not an answer about the incoming
     * one — it would validate the new sandbox's remembered pick against credentials from the old, and hand every
     * restored tab a foreign account id as the "first" one.
     *
     * Cleared rather than emptied-and-declared: the incoming sandbox's connections are unknown until ITS daemon
     * answers, and every surface shows that as a wait rather than as "you have nothing connected". */
    providerAccounts.value = perProvider<readonly OauthAccount[]>(() => []);
    accountsLoaded.value = false;
    // Rebuilds the tabs AND re-seeds the account pick from the incoming sandbox's own remembered one.
    restoreTabs();
    // The new sandbox's tabs get the same instant paint a reload does; the mirror is keyed by conversation, so
    // a switch reads that sandbox's transcripts, never the one just left.
    paintCachedTranscripts(conversations.value);
    sessions.value = [];
    providerModels.value = perProvider<ModelOption[]>(() => []);
    providerCommands.value = perProvider<readonly AgentCommand[]>(() => []);
    providerDefaultModel.value = perProvider(() => ``);
    providerModelsState.value = perProvider<CatalogLoadState>(() => `idle`);
    managedProvider.value = turnDefaults.provider.value;
    cancelConnect();
    clearTimeout(translatorPollTimer);
    translatorConnectFlow.value = undefined;
    accountBusy.value = undefined;
    translatorAccounts.value = { codex: [], grok: [], kimi: [], gemini: [] };
    providerRefusals.value = {};
    error.value = null;
};

// --- Tabs -------------------------------------------------------------------------------------
/* Open a fresh empty conversation and focus it. The store half of "New agent" — every surface that offers the
 * action goes through startAgent (agents/agentActions.ts), which is the one place that also puts the caret in
 * the composer and, on mobile, navigates to the new agent's screen. Other tabs keep streaming.
 *
 * IDEMPOTENT, because the strip holds at most one untouched draft (see setConversations): pressed while such a
 * tab is already open, this hands that one back and focuses it rather than minting a second the write would drop
 * on the spot. The two are indistinguishable to the user — an empty draft has nothing in it to tell them apart —
 * so the difference was only ever visible as a "+" that did nothing. What the press is FOR then is the caret,
 * which startAgent asks for either way.
 *
 * IT TAKES THE WHOLE PANEL, not the column the focus happened to be in. Every other arrival here — a board card,
 * a deep link, a history row — is "show me THIS chat", and swapping one column for it is right, because the
 * other columns are chats the reader deliberately put up beside it. A fresh agent is not an arrival, it is a
 * fresh START: nothing has been said in it yet, so there is nothing for the chat still sitting in the next
 * column to be beside. Replacing one half of a split left the reader looking at a brand-new empty composer with
 * somebody else's transcript pinned next to it, and the only way back to one chat was to dismantle the split by
 * hand. The other chats stay OPEN — this gives their columns back, it does not close them. */
const newChat = (): Conversation => {
    const open = conversations.value.find(untouchedDraft);
    const conversation = open ?? new Conversation();
    if (open === undefined) {
        setConversations([...conversations.value, conversation], conversation.conversationId, `new-chat`);
    } else {
        setConversations(conversations.value, conversation.conversationId, `new-chat-reuse`);
    }
    // After the write, so the column kept is the one the fresh chat has just been seated in.
    collapsePanes();
    return conversation;
};

/* Put an already-built conversation into the strip and focus it. `newChat` cannot serve this and the difference
 * is the point: it MINTS the conversation, whereas a suggested session has to exist — configured with a model,
 * an effort and a first message the user can still edit — for as long as the dialog is open, and may be
 * dismissed without ever becoming a tab (agents/sessionSuggestion.ts).
 *
 * Safe against the one-untouched-draft rule because a suggestion always arrives carrying its prompt in `draft`,
 * which is exactly what `untouchedDraft` reads as touched: this conversation is kept, and any empty draft the
 * strip was holding is reaped by the same write, which is the correct outcome either way.
 *
 * It collapses the split for the same reason `newChat` does, and that is not a coincidence to be tidied away
 * later: an accepted suggestion has to land exactly where "New agent" would have left the user, or the two
 * doors into a fresh session open onto two different rooms. */
export const adoptConversation = (conversation: Conversation): void => {
    setConversations([...conversations.value, conversation], conversation.conversationId, `adopt-suggested`);
    collapsePanes();
};

// "Put the caret in the composer", as a signal rather than a call: the conversation list is store state, but
// the caret belongs to whichever chat surface is mounted (the docked panel, the mobile detail, a popped-out
// window), and only that component holds the textarea. A counter, not a flag — two "New agent" presses in a
// row must each land, and a re-focus of the same conversation is still a distinct request.
const composerFocus = ref(0);
export const focusComposer = (): void => {
    composerFocus.value++;
};

// "Put the focused tab on screen", the counterpart of composerFocus and a counter for the same reason: the tab
// list is store state, but the SCROLL belongs to whichever strip is mounted, and asking again for the tab that
// is already focused — clicking its card on the fleet board while the strip is scrolled elsewhere — is still a
// distinct request. A plain activeId watch cannot see that one, since the id doesn't move.
const tabReveal = ref(0);

// Focus a tab, through the one writer — so leaving an untouched draft takes it with the same write that moves
// the focus. An id that names no open conversation is ignored rather than written: setConversations would seat
// the focus on the last tab instead, and a stale click would silently surface a chat the user didn't ask for.
const setActive = (conversationId: string): void => {
    if (conversations.value.some((conversation) => conversation.conversationId === conversationId)) {
        setConversations(conversations.value, conversationId, `select`);
        tabReveal.value++;
    }
};

const isOpen = (conversationId: string): boolean => conversations.value.some((conversation) => conversation.conversationId === conversationId);

/* --- The panes ---------------------------------------------------------------------------------
 * Three verbs over the pane set, and the only ways to change how many chats are on screen — everything else
 * that touches the focus goes through setActive and swaps a column rather than adding one.
 *
 * Give a chat a column of its OWN, immediately right of the focused pane (VSCode's Open to the Side), and put
 * the focus in it. Already on screen ⇒ this is just a focus move, which is what the user means by asking for a
 * chat they can already see.
 *
 * The column is claimed for an id that need not name an open tab YET, so a surface handing over a conversation
 * it is about to open — the fleet board's cards — calls this FIRST and opens second. That order is what stops
 * the opening from eating the focused pane's column on its way in: by the time the pane set is reconciled the
 * id names a real tab, the focus is already inside the set, and the chat that was there keeps its place. A
 * claim nobody follows through on costs nothing — the next reconcile drops an id that names no tab. */
const openBeside = (conversationId: string): void => {
    if (!panes.value.includes(conversationId)) {
        const beside = panes.value.indexOf(activeId.value);
        panes.value = panes.value.toSpliced(beside === -1 ? panes.value.length : beside + 1, 0, conversationId);
    }
    setActive(conversationId);
};

// Take a chat's column back. The chat itself stays open — it is still in the rail, one click from a column
// again — and the last pane is never closed, since that one IS the panel.
const closePane = (conversationId: string): void => {
    if (panes.value.length < 2 || !panes.value.includes(conversationId)) {
        return;
    }
    const rest = panes.value.filter((id) => id !== conversationId);
    panes.value = rest;
    if (activeId.value === conversationId) {
        // The neighbour that took its place on screen, which is where the eye already is.
        setActive(rest[rest.length - 1]!);
    }
};

/* BACK TO ONE COLUMN — the reset half of the gesture set, and the counterpart of setPanes.
 *
 * Every list that lets Shift and Ctrl build a selection also lets a PLAIN click replace it, and the surfaces
 * that put chats in columns (the rail's rows, the board's cards) are such lists: the ringed cards ARE the pane
 * set, so a click carrying no modifier means "just this one" there exactly as it does in a file list. Without
 * it a split could only be left one × at a time, which made arriving cheaper than leaving — and left actions
 * scoped to "what is on screen" (Synthesize) acting on a column the user thought they had walked away from.
 *
 * It names no id on purpose: the click has already moved the focus, so the chat to keep IS the focused one.
 * That also keeps it out of setActive, where it would wrongly collapse a deep link's or a history row's
 * arrival — those are not gestures on a selection.
 *
 * Its other caller is `newChat` (and `adoptConversation` with it), which is the same shape of act: a fresh
 * session is a fresh start, so it lands as the one chat on screen rather than as half of somebody else's split. */
const collapsePanes = (): void => {
    if (panes.value.length > 1) {
        panes.value = [activeId.value];
    }
};

/* The pane set as a whole — what a multi-selection on the rail or the board lands as. Chats already on screen
 * KEEP their columns and the newcomers are appended in the order given, so adding a third chat never reshuffles
 * the two the user is reading. An empty selection is not a request for an empty panel and is ignored; the way
 * to have fewer panes is to close one. */
const setPanes = (ids: readonly string[]): void => {
    const wanted = [...new Set(ids)].filter(isOpen);
    if (wanted.length === 0) {
        return;
    }
    const kept = panes.value.filter((id) => wanted.includes(id));
    panes.value = [...kept, ...wanted.filter((id) => !kept.includes(id))];
    if (!panes.value.includes(activeId.value)) {
        setActive(panes.value[0]!);
    }
};

// Close a set of tabs (the tab ×, or the strip menu's Close / Close Others / Close to the Right / Close All):
// detach from each in-flight turn (Conversation.abort is soft — the daemon-side run keeps working and reopening
// reattaches to it), drop each cached transcript, and keep at least one conversation — a fresh chat when
// the set empties the strip. Closing the active tab moves focus to the last remaining one (VSCode behaviour, the
// same rule the workspace's closeTabs follows). The daemon-side sessions survive: a closed chat is still in History.
const closeTabs = (ids: ReadonlySet<string>): void => {
    traceFocus(`close`, { ids: [...ids], active: activeId.value });
    for (const conversation of conversations.value) {
        if (ids.has(conversation.conversationId)) {
            conversation.abort();
            void dropTranscript(conversation.conversationId);
        }
    }
    const remaining = conversations.value.filter((conversation) => !ids.has(conversation.conversationId));
    const next = remaining.length > 0 ? remaining : [new Conversation()];
    setConversations(next, activeId.value, `close`);
};

/* THE SAME CLOSE, ASKED FOR BY THE DAEMON RATHER THAN BY THE USER — the tabs of agents that left the roster
 * without this browser doing it: the retention sweep filing a finished agent away (the daemon's
 * agents/archive.ts), or an archive or discard performed on another device.
 *
 * It exists because the two halves of "an agent is a card and a tab" only ever moved together when the press
 * happened HERE: archiving from this board closes the chat with the card (useAgents.archive), while the sweep
 * that does the same thing on its own left the tab behind. That is the whole of why the chat list's Finished
 * lane grew without bound while /agents stayed clean — the sweep is the board's cleaner and was the chat
 * list's litter. Nothing is lost either way (see closeTabs): the transcript is in History, and reopening the
 * agent from there brings the tab straight back.
 *
 * TWO TABS ARE SPARED, and both are about not taking something out from under the user:
 *   · the FOCUSED chat — the sweep runs on a clock the user cannot see, and a panel that empties itself
 *     mid-read is the worst thing an unattended cleaner can do. It reads as archived (ChatTabList's box mark)
 *     and closes like any other tab when the user is done with it.
 *   · one holding UNSENT INPUT (Conversation.unsent) — every other thing a chat holds survives a close; those
 *     words do not. The board makes the same promise from the other side: a session holding them keeps its
 *     card, so a sweep that spares the tab can't leave the fleet reporting the work as gone. */
/* A TURN THIS BROWSER DID NOT START, on a tab that is already open — attach to it.
 *
 * A tab hydrates when it opens, and that is the only moment it ever asked the daemon what was going on. Fine
 * for a chat you type into, and wrong for every session started somewhere else: a workflow's steps are opened
 * the instant the run exists, a beat BEFORE the scheduler starts their turns, so the attach probe finds
 * nothing and the pane sits on "start a conversation" while the agent behind it works. Nothing re-asked, so
 * the only cure was clicking the card again — which is what "one window left with no content" was.
 *
 * The roster is the signal, and it arrives on the events stream rather than on a timer (useAgents.setAgents):
 * the daemon publishes a card the moment a turn opens. Only a tab with NOTHING in it is touched — a transcript
 * already painted has its own reconciliation, and a streaming one IS the stream.
 */
const attachStarted = (ids: ReadonlySet<string>): void => {
    for (const conversation of conversations.value) {
        if (!ids.has(conversation.conversationId) || conversation.streaming.value || conversation.messages.value.length > 0) {
            continue;
        }
        hydrateOnce(conversation);
    }
};

const closeRetired = (ids: ReadonlySet<string>): void => {
    const retired = new Set(
        conversations.value
            .filter(
                (conversation) =>
                    ids.has(conversation.conversationId) && conversation.conversationId !== activeId.value && !conversation.unsent.value,
            )
            .map((conversation) => conversation.conversationId),
    );
    if (retired.size > 0) {
        closeTabs(retired);
    }
};

// --- Active-conversation actions (forwarded) --------------------------------------------------
// The composer's one send path, whatever the conversation is doing: an idle chat starts a turn, a running one
// takes the message mid-turn (or holds it until it settles). See Conversation.enqueue.
// --- History ----------------------------------------------------------------------------------
// Refresh the history list from the sandbox's session store (call when opening the history menu). A query
// filters the list by chat title or content, server-side.
// Each call ABORTS the one before it: a search is fired per settled keystroke, and without the abort a burst
// of queries piles up on the daemon and lands out of order — the slowest, stalest response overwriting the
// list the newest query already painted.
let sessionsLoad: AbortController | undefined;
const loadSessions = async (query?: string): Promise<void> => {
    sessionsLoad?.abort();
    const controller = new AbortController();
    sessionsLoad = controller;
    try {
        const response = await sandboxRequest(query ? `/sessions?query=${encodeURIComponent(query)}` : `/sessions`, { signal: controller.signal });
        if (!response.ok) {
            return;
        }
        const body = (await response.json()) as { sessions?: ChatSession[] };
        sessions.value = body.sessions ?? [];
    } catch {
        // Non-fatal (including our own abort); the menu shows whatever was loaded last.
    }
};

// Read a session's transcript from the daemon's session store, for both the history menu and the restored-tab
// rehydration watch. Returns undefined when the daemon has nothing, having reported it on the conversation.
const fetchTranscript = async (conversation: Conversation, id: string): Promise<RestoredMessage[] | undefined> => {
    try {
        const response = await sandboxRequest(`/sessions/${encodeURIComponent(id)}`);
        if (!response.ok) {
            conversation.error.value = `Could not open that conversation.`;
            return undefined;
        }
        const body = (await response.json()) as { messages?: RestoredMessage[] };
        return body.messages ?? [];
    } catch {
        conversation.error.value = `Could not open that conversation.`;
        return undefined;
    }
};

/* A registered agent's transcript, through the shared cached read (agentTranscript.ts) — so a card the
 * background loader already warmed opens without a round trip, and a card clicked WHILE it is being warmed
 * waits for that read instead of starting a second one. Archiving keeps the entry — the registry holds archived
 * agents and `entry(id)` finds them — so an archived agent answers 200 and its tab is never touched by this.
 *
 * What this adds over the cached read is the TAB's half: a failure is reported on the conversation, where the
 * user can see it, and folded to `undefined` so the caller retries rather than settling for an empty pane. The
 * "gone" verdict passes straight through — it is the one answer that says something about this conversation
 * rather than about the network. */
const fetchAgentTranscript = async (conversation: Conversation): Promise<AgentTranscript | undefined> => {
    try {
        return await agentTranscript(conversation.conversationId);
    } catch {
        conversation.error.value = `Could not open that conversation.`;
        return undefined;
    }
};

// Bring a tab with no visible transcript up to date with the daemon: attach to the turn running for its
// conversation right now, or — when nothing is running — replay its stored session. Shared by the restore
// watch above and by opening a fleet agent, which is what lets an agent an AUTOMATION opened for an outside
// message read as an ordinary chat: its whole transcript (the configured prompt, the message that woke it,
// the reply) exists only daemon-side until this runs.
// Returns whether the tab is now as current as the daemon can make it. False means the round-trip itself
// failed, not that there was nothing to show: the caller drops its hydrating mark then, so the next
// reachability flip tries again instead of leaving a restored tab visibly empty until the window is reloaded.
const hydrate = async (conversation: Conversation): Promise<boolean> => {
    /* The transcript has to be in place BEFORE attaching to anything live. reattach appends the running turn's
     * prompt bubble to whatever the transcript currently holds, and marks the conversation streaming — which
     * makes the cache paint stand down — so attaching first renders the live turn onto an EMPTY transcript and
     * then persists that stub over a perfectly good local mirror when the run settles. That is how a chat comes
     * back from a reload showing nothing but the message you just sent, with its whole history still sitting
     * intact in the daemon's session store.
     *
     * The mirror read is local and cheap, so it always goes first. Only when it comes up empty — a conversation
     * this device has never painted, e.g. a fleet agent opened for the first time — is the daemon's session
     * store worth waiting on before attaching; that is also the only case where there is nothing to show
     * meanwhile, so the round-trip costs nothing the user can see. */
    await conversation.paintCached();
    // Whether anything is THERE, not whether this call is what put it there: the restore sweep paints the
    // mirror on its own, so a paint that declines because the transcript is already populated must not be read
    // as "empty" and pay a session fetch the user would wait through on every restored tab.
    const seeded = conversation.messages.value.length === 0;
    // The one case with nothing to show while the daemon answers — say the transcript is on its way rather
    // than inviting the user to start over a conversation that merely hasn't arrived yet.
    conversation.loading.value = seeded;
    try {
        // A failed seed still lets the attach below run — a live turn is worth rendering either way — but it rides
        // out as the return value so the caller re-tries the read rather than settling for a tab that looks empty.
        const seededOk = seeded ? await replayStoredSession(conversation) : true;
        if (await conversation.reattach()) {
            return seededOk;
        }
        // With nothing running, what the mirror painted still has to be reconciled against the daemon — unless the
        // seeding above already read the very same store a moment ago.
        return seeded ? seededOk : await replayStoredSession(conversation);
    } finally {
        conversation.loading.value = false;
    }
};

/* Redraw a conversation from the daemon's own record — the authoritative transcript, and the only copy that
 * survives a device with no local mirror. False when the READ failed, as opposed to finding nothing to show, so
 * a transient round-trip failure is retried instead of leaving a restored tab visibly empty.
 *
 * Asked for EVERY provider. This used to return here unless the tab ran the Claude Code loop, on the reasoning
 * that /agents/:id/transcript could only answer for a harness with a readable session store — so a native
 * codex/grok or ACP tab never even asked, and opening one showed "Start a conversation with …" over a
 * conversation that had run for an hour. The daemon records what it streams now, whoever served it. */
const replayStoredSession = async (conversation: Conversation): Promise<boolean> => {
    // A fleet conversation is stable across runtime switches; its session id is not. Resolve registered agents
    // by conversation/worktree identity, then adopt the SDK session that actually supplied the transcript so the
    // next turn resumes what the user is looking at. History-menu tabs still mean one exact runtime session.
    let restored: RestoredMessage[] | undefined;
    if (conversation.registered.value) {
        const transcript = await fetchAgentTranscript(conversation);
        if (transcript === undefined) {
            return false;
        }
        if (transcript === `gone`) {
            /* THE ONE THING THAT UNLATCHES `registered`. The latch exists to outlive the roster — an archive
             * takes the entry off the board, a dropped stream takes the whole roster away, and neither means a
             * tab has stopped being an agent. But a NAMED 404 for this exact id is the daemon answering about
             * this conversation, and a tab that goes on claiming a fleet identity nobody has is unreachable
             * from the board while it sits in the strip: the registry half of the fleet has no entry for it and
             * the DRAFT half skips it for being registered, so it shows up nowhere on /agents and the
             * focus-leave sweep — which only ever takes unregistered drafts — can never take it either. That is
             * how an empty, untitled, permanent "New agent" tab is born, in a strip that is supposed to be the
             * board under another skin.
             *
             * Unlatched, it is what it actually is again: a conversation the daemon has never registered. Empty,
             * that makes it an ordinary untouched draft, so the sweep below takes it the way it takes any other;
             * with a transcript in it, it stays open and readable, and its next send registers it anew (the
             * daemon rebuilds the entry at begin, the same path an archived agent's next message takes). */
            conversation.registered.value = false;
            setConversations(conversations.value, activeId.value, `unlatch-registered`);
        } else {
            restored = transcript.messages;
            if (transcript.sessionId !== undefined) {
                conversation.session.value = {
                    id: transcript.sessionId,
                    provider: conversation.provider.value,
                    account: conversation.account.value,
                    harness: conversation.harness.value,
                };
            }
        }
    }
    // Not an else: a tab that just lost its agent still has whatever SDK session it recorded, and that store is
    // a different one — the transcript may well be readable there after the registry entry is gone.
    if (restored === undefined) {
        const session = conversation.session.value;
        if (session === undefined) {
            return true;
        }
        restored = await fetchTranscript(conversation, session.id);
        if (restored === undefined) {
            return false;
        }
    }
    /* A RUNNING TURN IS NOT IN THE RECORD, so a redraw from the record can only ever delete it. The daemon
     * writes a turn as it SETTLES, which means the answer in hand describes every turn but the live one — and
     * restoreMessages rebuilds the whole transcript. The live turn went with it: its prompt bubble, its tool
     * cards, and the card it was parked on. Nothing brought them back either, because a turn parked on a card
     * emits no further frames — leaving a spinner over a transcript that ends one turn early, with no card to
     * answer and a reload that reproduced it rather than fixing it.
     *
     * Asked AFTER the awaits, because that is where a stream gets in: this read and the attach that renders the
     * live turn are started by the same hydrate pass (and routinely by two of them at once), so the attach
     * lands first as often as not. Standing down costs nothing — whatever is streaming attached to a transcript
     * that was already painted, and the frames it is applying are the newer half of this same conversation.
     *
     * An empty replay is not a transcript either, it is the absence of one — the same distinction the mirror
     * makes when it refuses to save a blank. Painting it would blank a good cached transcript on any
     * daemon that answers but has nothing to say, which is exactly how a reopened tab goes empty. */
    if (restored.length > 0 && !conversation.streaming.value) {
        conversation.restoreMessages(restored);
    }
    return true;
};

/* One hydrate at a time per conversation, and two of them at once is the ORDINARY case rather than a corner:
 * opening a fleet agent starts one, and the pane's fleet watcher starts another the moment the roster names the
 * conversation. Each holds its own daemon round-trip, so the slower one answers about a tab the faster one has
 * already moved on — which is how a redraw lands on top of a turn attached in between.
 *
 * A second WeakSet, because `hydrating` cannot answer this: it marks a tab as hydrated FOR GOOD (the reachability
 * sweep reads it as "already done"), while the fleet watcher's whole job is to hydrate the same tab AGAIN when the
 * daemon says something about it changed. This one is in-flight only, and clears however the pass ends. */
const hydrateInFlight = new WeakSet<Conversation>();

// Hydrate a tab once, holding the mark only while (and after) the daemon actually answered. Exported for the
// pane's fleet watcher (ChatPane), which calls it whenever the fleet settles or starts something about a
// conversation this tab did not stream itself.
export const hydrateOnce = (conversation: Conversation): void => {
    if (hydrateInFlight.has(conversation)) {
        return;
    }
    hydrateInFlight.add(conversation);
    hydrating.add(conversation);
    void hydrate(conversation)
        .then((current) => {
            if (!current) {
                hydrating.delete(conversation);
            }
        })
        // A hydrate that could not reach the daemon leaves the tab exactly as it stands, and the reachability
        // watch below runs it again when the connection is back. Caught rather than left to reject: nothing
        // awaits this call, so an unreachable daemon was raising an unhandled rejection per open tab.
        .catch(() => hydrating.delete(conversation))
        .finally(() => hydrateInFlight.delete(conversation));
};

// Open (or focus) the tab bound to a fleet agent's conversationId, seeding identity from its registry summary.
// The daemon's provider-neutral transcript record hydrates workspace and isolated conversations alike, so no
// provider store or placement gets a separate open path. Exported for useAgents.open.
export const openAgentConversation = (agent: {
    id: string;
    sessionId?: string;
    title?: string;
    provider: AgentProvider;
    harness: AgentHarness;
    // Present exactly when this conversation owns an isolated worktree. A registry-opened workspace
    // conversation must explicitly clear Conversation's isolated-by-default posture before its next turn.
    branch?: string;
    account?: string;
    // What the agent's turns actually ran with, as the registry recorded them. Absent only for an agent that
    // has never run one (the board's draft card) — a real agent's settings are facts about it, and seeding the
    // tab from the remembered picks instead is what made the composer claim a model the session never used.
    model?: string;
    effort?: string;
    thinking?: boolean;
    fast?: boolean;
    // Whether the fleet actually knows this agent — true unless the caller knows better. The board's
    // client-only DRAFT card is the one that does: its conversation must stay a draft (carded, and taken by
    // the focus-leave sweep when abandoned) until a first turn registers it.
    registered?: boolean;
}): Conversation => {
    const registered = agent.registered ?? true;
    const existing = conversations.value.find((conversation) => conversation.conversationId === agent.id);
    // The id a card handed us, before anything acts on it — the anchor every later line is read against.
    traceFocus(`open-agent`, { id: agent.id, existing: existing !== undefined, registered });
    if (existing !== undefined) {
        setActive(existing.conversationId);
        // The fleet handed us this id, so the tab is a view of a real agent whatever the live roster says right
        // now — which is how an ARCHIVED agent opened from the archive view stopped painting a phantom "New
        // agent" card back onto the Active lane it had just left.
        if (registered) {
            existing.registered.value = true;
            existing.isolated.value = agent.branch !== undefined;
        }
        /* Opening the card is an explicit request to look again, however much the tab already shows. What it
         * shows may be a STUB: an attach that engaged and then died mid-turn (a closed pop-out, a dropped
         * stream) persists whatever had arrived — for a workflow step opened at run start, one user bubble —
         * and a tab was only ever re-read while it was EMPTY, so the stub was the one state that could never
         * heal: the reattach probe 404s once the turn is over, and nothing else asked the record again.
         * hydrate covers every case in order — a live turn attaches (and a tab already streaming returns from
         * the probe immediately), a settled one is reconciled against the daemon's own record, and a daemon
         * with nothing to say leaves the transcript as it stands (replayStoredSession paints only a non-empty
         * replay). Skipped while streaming: this tab is the stream, and rewriting under it is the one thing a
         * focus click must not do. */
        if (!existing.streaming.value) {
            hydrateOnce(existing);
        }
        return existing;
    }
    const conversation = new Conversation(agent.id);
    conversation.registered.value = registered;
    conversation.isolated.value = agent.branch !== undefined;
    conversation.provider.value = agent.provider;
    conversation.harness.value = agent.harness;
    conversation.account.value = agent.account ?? rememberedAccountFor(agent.provider);
    conversation.model.value = agent.model ?? rememberedModelFor(agent.provider);
    if (agent.thinking !== undefined) {
        conversation.thinking.value = agent.thinking;
    }
    if (agent.fast !== undefined) {
        conversation.fast.value = agent.fast;
    }
    if (agent.effort !== undefined) {
        conversation.effortPick.value = agent.effort;
    }
    conversation.title.value = agent.title ?? null;
    if (agent.sessionId !== undefined) {
        conversation.session.value = {
            id: agent.sessionId,
            provider: agent.provider,
            account: conversation.account.value,
            harness: agent.harness,
        };
    }
    setConversations([...conversations.value, conversation], conversation.conversationId, `open-agent`);
    // The agent may be mid-turn right now — attach and render it live (the head synthesizes the prompt
    // bubble). Marked as hydrating so the restore watch above doesn't race a second attach; an idle agent's
    // probe just 404s and its stored transcript is replayed instead.
    hydrateOnce(conversation);
    return conversation;
};

// Open a past conversation: focus its tab if already open, else load its transcript into a new tab.
const openConversation = async (id: string): Promise<void> => {
    const existing = conversations.value.find((conversation) => conversation.session.value?.id === id);
    if (existing) {
        setActive(existing.conversationId);
        return;
    }
    const conversation = new Conversation();
    // Titled from the history row BEFORE the transcript round-trip: a nameless empty tab awaiting its fetch
    // is indistinguishable from an untouched draft, and the focus-leave sweep would close it mid-load.
    const title = sessions.value.find((session) => session.id === id)?.title ?? null;
    conversation.title.value = title;
    conversation.loading.value = true;
    setConversations([...conversations.value, conversation], conversation.conversationId, `open-session`);
    try {
        const restored = await fetchTranscript(conversation, id);
        if (restored !== undefined) {
            conversation.loadTranscript(restored, id, title);
        }
    } finally {
        conversation.loading.value = false;
    }
};

// Restored tabs persist as session + title only — once their daemon is reachable, first try to ATTACH: a
// turn may be running for the conversation daemon-side (started before the reload, or by another window or
// device), and attaching renders it live mid-stream. Only when nothing is running does the flat transcript
// hydrate from the session store. `conversations` is in the source so tabs restored by a sandbox switch
// (when reachability may already be true and never flip) are still picked up; the WeakSet keeps unrelated
// tab churn from re-firing work already in flight. A registered tab hydrates from /agents/:id/transcript, which
// answers for every provider (the daemon records what it streams); an unregistered one still means one exact
// runtime session and reads /sessions/:id, which is the Claude Code SDK's store alone.
const hydrating = new WeakSet<Conversation>();
// Conversations showing a locally cached transcript rather than a daemon-confirmed one. They still hydrate —
// the cache decides what the user looks at during the round-trip, not whether the round-trip happens — so the
// "already has messages, leave it alone" guard below must not mistake a painted mirror for live content.
const painted = new WeakSet<Conversation>();

// Paint every restored tab from the local mirror immediately, without waiting for the sandbox to be reachable
// (see transcriptCache). This is the whole point of the cache: a reopened chat is readable at once instead of
// after a probe, a tunnel round-trip, and a session-store read.
const paintCachedTranscripts = (list: readonly Conversation[]): void => {
    for (const conversation of list) {
        void conversation.paintCached().then((didPaint) => {
            if (didPaint) {
                painted.add(conversation);
            }
        });
    }
};
paintCachedTranscripts(conversations.value);

watch([reachable, conversations], ([isReachable]) => {
    if (!isReachable) {
        return;
    }
    for (const conversation of conversations.value) {
        if ((conversation.messages.value.length > 0 && !painted.has(conversation)) || conversation.streaming.value || hydrating.has(conversation)) {
            continue;
        }
        hydrateOnce(conversation);
    }
});

// --- Account / connection ---------------------------------------------------------------------
// Step 1 of a NATIVE connect. Claude mints an authorize URL + PKCE challenge; Grok mints a one-time device code
// and starts its poll loop. Routed subscription connects, including Kimi Code, use connectTranslator above.

// Started by the row's own Connect button (never by a provider switch — see setManagedProvider), so the whole
// handshake is a thing the user asked for. `accountBusy` holds the provider for the length of the round-trip:
// that is the click's acknowledgement, and it is why the sign-in can only ever REPLACE the button that started
// it rather than appear next to a button still inviting the same click.
const startConnect = async (): Promise<void> => {
    const target = managedProvider.value;
    if (accountBusy.value !== undefined) {
        return;
    }
    cancelConnect();
    error.value = null;
    // Busy for the WHOLE start, not just the fetch: clearing it a parse earlier would drop the button back to
    // "Connect" for a tick before the flow lands under it — the very blink this is here to remove.
    accountBusy.value = target;
    try {
        let response: Response;
        try {
            response = await sandboxRequest(`${providerBase(target)}/oauth/start`, { method: `POST` });
        } catch (err) {
            error.value = errorMessage(err, `Could not start the ${providerLabel(target)} connection — is your sandbox online?`);
            return;
        }
        if (!response.ok) {
            const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
            error.value = body?.error ?? `Could not start the ${providerLabel(target)} connection — is your sandbox online?`;
            return;
        }
        if (target === `grok`) {
            // xAI's headless device-code flow: the URL is x.ai's verification page with the code pre-filled, so
            // the user just opens it and approves (no paste-back). `code` is that same pre-filled code, shown
            // for reassurance. OpenCode polls to completion — we poll /grok/accounts until connected.
            const body = (await response.json()) as { url: string; code: string };
            nativeConnectFlow.value = { provider: `grok`, url: body.url, code: body.code };
            grokPollTimer = setTimeout(() => void pollGrokOnce(Date.now() + CODEX_POLL_DEADLINE_MS), 3000);
            return;
        }
        const body = (await response.json()) as { authorizeUrl: string; verifier: string; state: string };
        nativeConnectFlow.value = { provider: `claude`, url: body.authorizeUrl, code: ``, pkce: { verifier: body.verifier, state: body.state } };
    } finally {
        accountBusy.value = undefined;
    }
};

/* Point the account card at the provider the active conversation would send to — what it shows when it opens.
 * Skipped while a sign-in is in flight: that handshake (a device poll can outlive the card being closed and the
 * reachable-flash remounting it) owns what the card is looking at, and moving to another provider's rows would
 * hide the code the user is in the middle of approving.
 *
 * Nothing here tears a handshake down, and nothing does on the way out either — there is no "close" hook at all.
 * The Grok device flow completes out-of-band (the user approves at x.ai and the daemon exchanges tokens
 * server-side later), so cancelConnect stays the sole teardown, driven only by genuine invalidation:
 * completion (pollGrokOnce), the 15-minute deadline, a fresh startConnect, the user's own Cancel, or resetChat. */
const showActiveProvider = (): void => {
    if (nativeConnectFlow.value === undefined && translatorConnectFlow.value === undefined) {
        managedProvider.value = provider.value;
    }
};

/* Read every connection this sandbox holds — the providers' own accounts AND the translator's subscriptions.
 * One call, because to a user they are one question ("what is my agent signed in with?"), and because the
 * answer has to arrive as one state: two independently-landing halves is a card that rearranges itself twice.
 *
 * Landing the reads is also what earns the right to say "not connected": `accountsLoaded` flips only if a read
 * actually came back, so a daemon that is unreachable or mid-restart leaves the surfaces waiting (the reachable
 * seam retries) instead of asserting an empty state it cannot back up. The translator read is excluded from
 * that vote deliberately — it swallows its own failure, so it always "succeeds". */
export const refreshConnections = async (force = false): Promise<void> => {
    const natives = NATIVE_PROVIDERS.filter((target) => !subscriptionOnly(target));
    const [reads] = await Promise.all([
        Promise.allSettled(natives.map((target) => refreshAccounts(target, force))),
        refreshTranslatorAccounts(),
        refreshProviderRefusals(),
    ]);
    if (reads.some((read) => read.status === `fulfilled`)) {
        accountsLoaded.value = true;
    }
};

// Everything daemon-owned the chat needs, on the seam where it can first be read. Module-exported (like
// resetChat) for sandboxScope, which re-runs it whenever the active daemon becomes reachable — connections and
// catalogs live on the daemon, so reachability is the moment either can actually be asked for.
export const loadAccountStatus = async (): Promise<void> => {
    await Promise.all([
        // Which accounts and subscriptions this sandbox is signed in with — the gate every provider surface reads.
        refreshConnections(),
        // Model lists are daemon-owned too — load them on the same reachable seam so the pickers are ready.
        loadAllProviderModels(),
        // Installed ACP agents and model endpoints are providers too — surface them on the same seam.
        loadCapabilityProviders(),
        // Each provider's last-published slash commands, so a fresh conversation's `/` popover is populated
        // before its first turn. Claude only: the ACP list arrives per session on the wire anyway, and an ACP
        // provider isn't known until loadAcpProviders resolves.
        loadProviderCommands(`claude`),
    ]);
};

/* The two capability kinds that MINT PROVIDERS, read in one pass because they come from one list: `agent`
 * capabilities are ACP agents (which own their model, so the row IS the provider) and `endpoint` capabilities
 * are model APIs (which have a catalog of their own, loaded straight after).
 *
 * An endpoint's provider id carries the `endpoint/` prefix — that is what tells every surface it runs the full
 * Claude Code loop rather than the ACP floor (capabilitiesOf), and it is what the turn is sent as. */
/* Read the free trial's remaining allowance. Separate from the capability read that discovers the trial exists,
 * because the two answer to different clocks — which endpoints exist changes when someone adds one, while this
 * changes with every message anyone on this account sends, from any tab.
 *
 * A failure leaves the previous figures rather than zeroing them: the count is a courtesy, and a picker that
 * flashed "0 left" because one poll missed would tell a user their trial had ended when it had not. */
const loadTrialStatus = async (): Promise<void> => {
    try {
        trialStatus.value = (await sandboxJson(`/endpoints/trial/status`)) as TrialStatusResponse;
    } catch {
        // Left as-is; the next reachable load asks again.
    }
};

/* Re-read the allowance the moment a turn settles, so the badge reflects the message that was just sent rather
 * than the state before it. Only for a turn that actually spent the trial: every other provider runs on the
 * user's own account and its count is none of this meter's business, and polling the platform after a Claude
 * turn would be a request that can only ever return the same number. */
watch(streaming, (isStreaming, was) => {
    if (was === true && !isStreaming && isTrialProvider(provider.value)) {
        void loadTrialStatus();
    }
});

const loadCapabilityProviders = async (): Promise<void> => {
    let entries: { id: string; kind: string; config: Record<string, unknown> }[];
    try {
        const body = (await sandboxJson(`/capabilities`)) as { capabilities?: { id: string; kind: string; config: Record<string, unknown> }[] };
        entries = body.capabilities ?? [];
    } catch {
        // Leave the last lists; the picker simply misses new providers until the next reachable load.
        return;
    }
    acpProviders.value = entries
        .filter((entry) => entry.kind === `agent`)
        .map((entry) => ({ id: entry.id, label: typeof entry.config[`name`] === `string` ? (entry.config[`name`] as string) : entry.id }));
    // Labelled by the name the user gave the capability — there is no vendor to name here, and the id is the
    // word they will recognise ("ollama", "gpu-box"). The one exception is the trial, which the user did not
    // name because they did not add it: the daemon provisioned it, so it carries the product's own words.
    endpointProviders.value = entries
        .filter((entry) => entry.kind === `endpoint`)
        .map((entry) => {
            const id = endpointProvider(entry.id);
            return { id, label: isTrialProvider(id) ? TRIAL_LABEL : entry.id };
        });
    // The trial's allowance moves with every message, so it is read on the same seam that discovered the trial
    // exists. Failure leaves the last figures — a picker that briefly shows a stale count is better than one
    // that drops the row a user is mid-conversation on.
    void loadTrialStatus();
    // Each endpoint's catalog is daemon-owned like every other provider's, so load them on the same seam. Not
    // part of loadAllProviderModels: that one runs over a fixed list, and which endpoints exist is what we have
    // only just learned.
    await Promise.all(endpointProviders.value.map((endpoint) => loadProviderModels(endpoint.id)));
};

// Step 2 of the native paste-back connect: exchange the code Anthropic showed against the PKCE handshake.
// Grok completes via its device poll loop; routed redirects complete through completeTranslator.
const completeConnect = async (code: string): Promise<boolean> => {
    const flow = nativeConnectFlow.value;
    accountBusy.value = flow?.provider;
    try {
        if (flow?.pkce === undefined) {
            error.value = `Start the connection first.`;
            return false;
        }
        let response: Response;
        try {
            response = await sandboxRequest(
                `/claude/oauth/exchange`,
                jsonBody(`POST`, { code, ...flow.pkce, label: connectLabel.value.trim() || undefined }),
            );
        } catch {
            error.value = `Could not connect your Claude account — check the code and try again.`;
            return false;
        }
        if (!response.ok) {
            error.value = `Could not connect your Claude account — check the code and try again.`;
            return false;
        }
        addAccount(`claude`, (await response.json()) as OauthAccount);
        cancelConnect();
        error.value = null;
        // The account just connected — supportedModels() needs a Claude credential, so the catalog may only now
        // be discoverable.
        void loadProviderModels(`claude`);
        return true;
    } finally {
        accountBusy.value = undefined;
    }
};

// Swap one account of a provider in place, leaving order and selection alone — the difference between a WRITE
// to an existing account and a new one arriving (see addAccount, which moves it to the end and selects it).
const replaceAccount = (target: AgentProvider, next: OauthAccount): void => {
    providerAccounts.value = {
        ...providerAccounts.value,
        [target]: accountsOf(target).map((entry) => (entry.id === next.id ? next : entry)),
    };
};

/* Rename one account of the managed provider. The credential is untouched — this writes the DISPLAY NAME, the
 * one thing that lets a second connection of the same provider tell itself apart when the provider hands back
 * no identity to derive one from (a pasted API key), or when the derived one isn't what the user calls it.
 *
 * Applied to the list BEFORE the round-trip and reconciled after: the name is the user's own keystrokes, so
 * showing it back to them is not a guess, and a rename that repaints a tunnel-latency later reads as one that
 * didn't take. The daemon's answer still wins (a blank means "back to the derived name", which only it knows),
 * and a failure re-reads rather than leaving an optimistic name standing over a write that never landed.
 *
 * Deliberately does NOT take `accountBusy`: that ledger drives the row's Disconnect spinner and gates
 * `startConnect`, and a rename is neither of those things. */
const renameAccount = async (id: string, label: string): Promise<void> => {
    const target = managedProvider.value;
    const typed = label.trim();
    const current = accountsOf(target).find((entry) => entry.id === id);
    if (current === undefined) {
        return;
    }
    if (typed !== ``) {
        replaceAccount(target, { ...current, label: typed });
    }
    let response: Response;
    try {
        response = await sandboxRequest(`${providerBase(target)}/account/rename`, jsonBody(`POST`, { id, label: typed }));
    } catch (err) {
        error.value = errorMessage(err, `Could not rename that account — is your sandbox online?`);
        replaceAccount(target, current);
        return;
    }
    if (!response.ok) {
        // A 404 means the row is gone (disconnected from another device or another tab), so re-read rather than
        // restore a name onto an account that no longer exists: the honest answer to a failed write is the
        // current truth, not the state we came from.
        error.value = response.status === 404 ? `That account is no longer connected.` : `Could not rename that account.`;
        await refreshAccounts(target, false).catch(() => replaceAccount(target, current));
        return;
    }
    replaceAccount(target, (await response.json()) as OauthAccount);
    error.value = null;
};

// Disconnect one account of the managed provider by id; drop it from the list and fix the selection. Busy for
// the round-trip, like every other account write — the row's own button says so.
const disconnect = async (id: string): Promise<void> => {
    const target = managedProvider.value;
    accountBusy.value = target;
    await sandboxRequest(`${providerBase(target)}/account/disconnect`, jsonBody(`POST`, { id }))
        .catch(() => undefined)
        .finally(() => (accountBusy.value = undefined));
    const remaining = accountsOf(target).filter((entry) => entry.id !== id);
    providerAccounts.value = { ...providerAccounts.value, [target]: remaining };
    if (selectedAccountId.value[target] === id) {
        selectedAccountId.value = { ...selectedAccountId.value, [target]: remaining[0]?.id };
    }
    // The chats that were running on it move on too, rather than holding an id nothing can serve.
    repointStranded(target, remaining);
};

export function useChat() {
    return {
        conversations,
        activeId,
        active,
        panes,
        openBeside,
        closePane,
        collapsePanes,
        setPanes,
        sessions,
        messages,
        streaming,
        availableCommands,
        awaitingDecision,
        pendingPlanMessage,
        activeModel,
        contextUsage,
        capabilities,
        mode,
        provider,
        selectProvider,
        harness,
        selectHarness,
        account,
        selectAccount,
        accounts,
        managedAccounts,
        accountUsage,
        model,
        selectModel,
        effort,
        thinking,
        fast,
        fastOffered,
        fastMode,
        draft,
        attachments,
        error,
        connected,
        claudeConnected,
        managedProvider,
        setManagedProvider,
        nativeConnectFlow,
        connectLabel,
        accountsLoaded,
        accountBusy,
        translatorKey,
        newChat,
        composerFocus,
        tabReveal,
        setActive,
        closeTabs,
        closeRetired,
        attachStarted,
        send,
        queued,
        removeQueued,
        steerable,
        forkAt,
        stop,
        decidePlan,
        answerQuestion,
        cancelQuestion,
        decidePermission,
        loadSessions,
        openConversation,
        showActiveProvider,
        loadUsage,
        startConnect,
        completeConnect,
        cancelConnect,
        renameAccount,
        disconnect,
        translatorAccounts,
        translatorConnectFlow,
        connectTranslator,
        completeTranslator,
        cancelTranslatorConnect,
        disconnectTranslator,
    };
}
