import { type AgentCommand, type ContextUsage, newConversationId, type TurnFact } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";
import type { AgentStanding } from "../../agents/fleet/agentStatus";
import type { PendingAttachment } from "../drafts/useChatAttachments";
import type { PickUp } from "../run/pickUp";
import { TurnFailures } from "../run/turnFailures";
import type { SessionRef } from "../run/turnRequest";
import { CardReplies } from "./cardReplies";
import { ComposerSelection } from "./composerSelection";
import { TranscriptView } from "./transcriptView";
import { TurnClient } from "./turnClient";
import { applyTurnEntry } from "./turnFacts";

// One chat conversation, self-contained so several run at once: what it is (identity, placement, the tab's own facts)
// and the units that do its work — `transcript` (rows, pages, fork/rewind/edit), `selection` (the next turn's picks),
// `turn` (sending, streaming, the queue, stop), `requests` (answering a card), `failures` (what a failed turn does).
// It is their composition and nothing else: every behaviour is one unit's, reached through it.

// What a conversation is doing right now, surfaced as the tab's status icon.
export type ConversationStatus = "idle" | "streaming" | "awaiting" | "error";

export class Conversation {
    // The red line: this needs the user. Per-turn chat errors land here; account errors live with the accounts.
    readonly error = ref<string | null>(null);
    // Offer to resume a turn that stopped short (stop, crash, outage, spent allowance); cleared by the next turn.
    readonly pickUp = ref<PickUp | undefined>();

    // Header title for this conversation; null shows "New chat". Derived from the first user message.
    readonly title = ref<string | null>(null);

    // Whether this conversation's turns run in an isolated git worktree (default) or the shared /work tree.
    readonly isolated = ref(true);

    // Machine this conversation runs on: a paired runner's id, or undefined for this sandbox; latched early.
    readonly runner = ref<string | undefined>();

    // Sandbox this conversation lives in, or undefined for this browser's box; every call is aimed at it.
    readonly box = ref<string | undefined>();

    // Whether the fleet has ever known this conversation; latches rather than tracks the roster, so a dropped roster
    // can't un-register it. Persisted with the tab.
    readonly registered = ref(false);

    // A tab opened for a glance (fleet card, history row), swept once focus leaves. Every verb of the reader's that
    // changes the conversation clears it; only the roster sets it again (useChat-tabs.releaseDone).
    readonly peek = ref(false);

    // Blank fallback a panel shows with no tabs, or after closing its last; says nothing about what the chat is.
    readonly standIn = ref(false);

    // The daemon's account of this agent when its card opened the chat (AgentStanding: status, attention, watches,
    // spent-allowance state), carried so a window whose roster hasn't answered still places the card in the lane the
    // board gives it. Superseded by the roster wherever one exists, and dropped the moment a turn runs here, which is
    // fresher than anything the card said.
    readonly standing = ref<AgentStanding | undefined>(undefined);

    // Saved workflow design the next message runs through, if any; not sticky, clears on send.
    readonly workflowId = ref<string | undefined>();
    // Saved loop the next message runs as, if any; not sticky, clears on send like `workflowId`.
    readonly loopId = ref<string | undefined>();

    // This conversation's composer draft: unsent text and staged attachments; per-tab, persisted per sandbox.
    readonly draft = ref(``);
    readonly attachments = ref<PendingAttachment[]>([]);

    // When the composer first held something unsent, for age-based UnsentMark; cleared on the reverse edge.
    readonly draftAt = ref<number | undefined>();

    // Where this conversation was cut from, until the daemon accepts a turn carrying it; a fork's only record.
    readonly pendingForkOf = ref<{ conversationId: string; keep: number; files: "then" | "now" } | undefined>(undefined);

    // Session the next matching turn resumes, with the provider/account that minted it; public for the manager.
    readonly session = ref<SessionRef | undefined>();

    // tmux session this conversation's Bash runs in (`agent-<sdk session>`); undefined until the first Bash.
    readonly agentTerminal = ref<string | undefined>();

    // Same as `agentTerminal`, for the browser this conversation's agent drives (`browser-<sdk session>`).
    readonly agentBrowser = ref<string | undefined>();

    // Worktree identity from the turn's `worktree` frame: agent/<id> branch and base sha; undefined until isolated.
    readonly worktree = ref<{ branch: string; base: string } | undefined>();

    // The model the SDK actually resolved for the latest turn (from its init message), when reported.
    readonly activeModel = ref<string | null>(null);

    // Context-window fill for this conversation (tokens sent vs the model's window), updated at the end of each turn.
    readonly contextUsage = ref<ContextUsage | undefined>();

    // This conversation's slash commands, replaced whole per `commands` frame, listed by the composer's `/` popover.
    readonly availableCommands = ref<readonly AgentCommand[]>([]);

    // Speed the harness actually served the last turn at, with its reason if not the one asked for; kept across turns.
    readonly fastMode = ref<Extract<TurnFact, { kind: `fast_mode` }> | undefined>();

    readonly transcript: TranscriptView;
    readonly selection: ComposerSelection;
    readonly turn: TurnClient;
    readonly failures: TurnFailures;
    readonly requests: CardReplies;

    // Whether this window holds words nowhere else does (draft, attachment, queued message); guards a tab from closing.
    readonly unsent = computed<boolean>(
        () => this.draft.value.trim() !== `` || this.attachments.value.length > 0 || this.turn.queued.value.length > 0,
    );

    // What this conversation is doing, for the tab's status icon.
    readonly status = computed<ConversationStatus>(() => {
        if (this.error.value !== null) {
            return `error`;
        }
        if (this.transcript.awaitingDecision.value) {
            return `awaiting`;
        }
        return this.turn.streaming.value ? `streaming` : `idle`;
    });

    // The conversation's whole identity: key for the fleet entry, worktree, tab, and mirror; a word pair, not a UUID.
    // The runs come first: every other unit reads whether one is live, and an edit sends through them.
    constructor(readonly conversationId: string = newConversationId()) {
        this.turn = new TurnClient(this);
        this.transcript = new TranscriptView((entry, turn) => applyTurnEntry(this, entry, turn), {
            conversationId,
            box: this.box,
            draft: this.draft,
            attachments: this.attachments,
            error: this.error,
            session: this.session,
            turn: this.turn,
        });
        this.selection = new ComposerSelection({
            session: this.session,
            activeModel: this.activeModel,
            contextUsage: this.contextUsage,
            fastMode: this.fastMode,
            transcript: this.transcript,
            box: this.box,
            turn: this.turn,
            peek: this.peek,
        });
        this.failures = new TurnFailures({
            transcript: this.transcript,
            provider: this.selection.provider,
            account: this.selection.account,
            model: this.selection.model,
            session: this.session,
            error: this.error,
            pickUp: this.pickUp,
            turn: this.turn,
        });
        this.requests = new CardReplies({
            box: this.box,
            transcript: this.transcript,
            error: this.error,
            turn: this.turn,
            peek: this.peek,
        });
    }
}
