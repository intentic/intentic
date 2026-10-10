<script setup lang="ts">
import TourMark from "../../../tour/TourMark.vue";
import {
    type ActionItem,
    Button,
    formatMoney,
    OverflowActions,
    ResponsiveOverlay,
    SandboxLogo,
    SegmentRing,
    timeAgo,
    type Tip,
    type TooltipValue,
    ui,
    useDevice,
} from "@intentic/ui";
import { createInlineRename } from "@intentic/ui/inline-rename";
import { messageOr } from "@intentic/ui/async";
import { computed, ref, useTemplateRef } from "vue";
import { requestLandAgent } from "../../fleet/agentActions";
import { refreshAcross } from "../../../sandbox/live/fleetAcross";
import { useRole } from "../../../../client/sandbox/useRole";
import { useAudience } from "../../../../app/useAudience";
import { useVocabulary } from "../../../../workbench/views/vocabulary";
import OriginMark from "../../fleet/OriginMark.vue";
import AgentCardClock from "./AgentCardClock.vue";
import AgentReactions from "./AgentReactions.vue";
import OwnerMark from "../session/OwnerMark.vue";
import ParentMark from "../session/ParentMark.vue";
import { parentOf, sessionMark } from "../ownership";
import { useAuth } from "../../../../client/auth/useAuth";
import { presenceOthers } from "../../../../workbench/presence/usePresence";
import UnsentMark from "../../../../components/UnsentMark.vue";
import WorkflowMark from "../../../../components/WorkflowMark.vue";
import { dropActionFor, type PendingAction } from "../laneDrop";
import type { IdMatch } from "../idMatch";
import {
    activityLine,
    agentDisplayTitle,
    agentStandingMeta,
    attentionReason,
    conflictIsYours,
    contextPct,
    type FamilyChip,
    type FleetLane,
    landedAway,
    landedDelivery,
    landFailure,
    laneOf,
    limited,
    limitScheduled,
    loopMeta,
    memoryHeld,
    reviewAction,
    type StandingChip,
    standingChip,
    tileRim,
    turnInFlight,
    turnWorking,
    unregistered,
} from "../../fleet/agentStatus";
import CardSeal from "./CardSeal.vue";
import CardPermissionAsk from "./CardPermissionAsk.vue";
import { cardProof, type ProofMark, sealStandsIn as standsIn } from "./proofSeal";
import { reachLine } from "./reachLine";
import KeepWarmPanel from "../../fleet/prompt-cache/KeepWarmPanel.vue";
// Not an emit: the destination is the same for every host this card has, and the review panel's own ladder sends the
// user to exactly this place for exactly this refusal.
import { type MatchSnippet, providerLabel } from "@intentic/sandbox-contract";
import { sessionCategory } from "../../../../app/sessionCategory";
import IdentityTile from "../../../capabilities/connect/IdentityTile.vue";
import MatchLine from "../../../../components/MatchLine.vue";
import SessionChip from "../session/SessionChip.vue";
import SessionMetrics from "../../metrics/SessionMetrics.vue";
import ChildCount from "./ChildCount.vue";
import { boxImageOf, boxNameOf } from "../../fleet/fleetScope";
import { accountBadge } from "../session/accountChip";
import { previewOf } from "../../../chat/panel/useChat-strip";
import { providerAccounts } from "../../../chat/accounts/providerAccounts";
import { markSegments } from "../../../../lib/markSegments";
import { settingsChip, useSettingsRefusal } from "../../review/settingsRefusal";
import { useAgents } from "../../fleet/useAgents";
import { canArchive, type FleetAgent } from "../../fleet/useAgents-fleet";
import { modelLabelFor } from "../../../chat/accounts/providerCatalog";
import { useT } from "@intentic/ui/i18n";
import { formatChord, isApplePlatform } from "../../../../workbench/commands/keybindings";

// One fleet agent: identity tile + title + status chip, a model/session line, and a closing summary line (stats,
// drill-in, and either the running elapsed or the settled date).
// The clock corner (AgentCardClock) reads the shared useNow clock itself, so a tick redraws that corner and not the card
// or the board; root is a div-button (not <button>) so the nested rename input stays valid HTML.
// `dense` is the same card as a row, for stacked lanes: identical DOM and facts, just wrapped onto one line instead of
// stacked, so a lane fits more cards.

const t = useT();

const props = defineProps<{
    agent: FleetAgent;
    dense?: boolean;
    dragging?: boolean;
    // Action the board has in flight, withholding every other press; what it did is the card's own drawn standing.
    pending?: PendingAction;
    // This agent's chat is on screen, one weight regardless of how many columns share it.
    selected?: boolean;
    // Chat is open only as a temporary look (Conversation.peek); italic title, with a keep press to make it stick.
    peek?: boolean;
    // Evidence for why the board's filter matched; absent when the hit was the title, marked there instead.
    match?: MatchSnippet;
    // The filter named this card by its id, or a piece of it (idMatch.ts); whole, the card wears the found halo.
    idMatch?: IdMatch;
    query?: string;
    // Filter's case-sensitivity switch, so marks are struck under the rule search actually used.
    matchCase?: boolean;
    // Children riding under this card that its archive or restore takes along (childFold), so the press says so.
    family?: number;
    // The lane the board drew this card in, when its family moved it above its own (childFold): a child calling the reader
    // through it, or still working under it after it finished. The card wears that lane's weight and tint.
    placed?: FleetLane;
    // What the children calling the reader through this card say in its corner (agentStatus.familyChip).
    call?: FamilyChip;
}>();
const emit = defineEmits<{
    // The click that opened it, if any; a modified click asks for a pane instead of focus.
    open: [event?: MouseEvent];
    review: [];
    resolve: [];
    land: [];
    // Separate from `land`: relands the whole output, not just the remainder, and must never fire by accident.
    reland: [];
    // Disarms every outside condition this conversation is parked on.
    unwatch: [];
    // Ends a command it left running: one its watch waits on that sits at a prompt.
    stopJob: [jobId: string];
    archive: [];
    restore: [];
    close: [];
    // Keeps a chat open that this card's click only opened as a look (see `peek`).
    keep: [];
    grab: [event: PointerEvent, card: HTMLElement];
}>();

const { mobile } = useDevice();
const { user } = useAuth();
// Whose it is, decided here rather than inside the mark, since the line the mark rides must know whether it has
// anything at all to draw: a card of the reader's own says nothing about ownership and spends no row on it.
const provenance = computed(() => sessionMark(props.agent, user.value?.email, presenceOthers.value));
// The conversation that spawned this one; a card only a child standing apart from its parent wears (ParentMark).
const parent = computed(() => parentOf(props.agent.startedBy));
// Whether this card's archive or restore moves its children with it, as a run's takes its steps.
const takesFamily = computed(() => (props.family ?? 0) > 0);
const meta = computed(() => agentStandingMeta(props.agent));
// Identity tile's category, undefined for an unreadable title; read here too since the tooltip is this card's.
const category = computed(() => sessionCategory(props.agent.title, props.agent.titleAction));
const lane = computed(() => props.placed ?? laneOf(props.agent));
// Sandbox chip contents, or nothing when this is the box the app is already pointed at.
// Read live from the roster rather than passed in, since the owner can rename or re-image a sandbox at any time.
const box = computed(() =>
    props.agent.sandboxId === undefined
        ? undefined
        : { name: boxNameOf.value.get(props.agent.sandboxId) ?? t(`agents.agentCard.anotherSandbox`), image: boxImageOf.value.get(props.agent.sandboxId) },
);
// The corner's word and tint, from the projection the rails read too (agentStatus.standingChip): why it needs you,
// else why the agents it started do (their mark rides along, so their ask never reads as this card's own), else that it
// worked since you last looked, else nothing and the resting glyph keeps the corner.
// What another agent's card is called, for the corner of a card whose messages wait on that agent's land.
const titleOfAgent = (conversationId: string): string | undefined => {
    const awaited = useAgents().agentById(conversationId);
    return awaited === undefined ? undefined : agentDisplayTitle(awaited);
};
const chip = computed<(StandingChip & { readonly hint?: Tip; readonly family?: true }) | undefined>(() => {
    const own =
        props.call !== undefined && attentionReason(props.agent) === undefined ? { ...props.call, family: true as const } : standingChip(props.agent, titleOfAgent);
    // Files a Sandbox page wrote are not "Your edits": named as the review names them (settingsPages, below), as the
    // rail's row names them too (settingsChip).
    return settingsChip(own, props.agent, settingsPages.value);
});
// Shared with agentStatus.activityLine so the rail and board never narrate the same turn differently.
const activityText = computed(() => activityLine(props.agent));
// Archive appears wherever it means something (not just the Finished lane, see canArchive), including in Attention,
// since nothing is lost by it.
// It sits beside the rename pencil, reachable by touch and keyboard, rather than behind the drag gesture which only
// exists mid-drag.
// Archive and rename are this sandbox's only: a card from another box has no entry in the active daemon's roster to
// write to.
// Land, discard, and stop differ: those address the agent by id through the daemon directly, so they cross sandboxes
// intact.
const localOnly = computed(() => props.agent.sandboxId === undefined);
// On a phone the header's presses fold behind one ⋯ (OverflowActions), so Archive is a deliberate second step there: its
// icon's 44px target once reached into the card body, and one tap filed away an agent and its seven children.
const archivable = computed(() => localOnly.value && canArchive(props.agent));
// The only exit for a card with no daemon entry (a draft, a refused send, an unfiled turn): archive, discard, land, and
// drop are all unavailable to it.
// Without this, a broken send would sit unrecoverable in the Active lane, surviving reloads with the tab.
const closable = computed(() => unregistered(props.agent.status));
// What closing actually destroys differs: a `starting` turn keeps running daemon-side (only this window's view of it
// closes).
// A draft holding unsent text is the one case where closing does lose something, so the hint has to name it.
const closeHint = computed(
    (): Tip => ({
        title: t(`ui.action.close`),
        note:
            props.agent.status === `starting`
                ? t(`agents.agentCard.closeKeepsRunning`)
                : props.agent.unsent
                  ? t(`agents.agentCard.closeDropsUnsent`)
                  : t(`agents.agentCard.closeNothingKept`),
    }),
);
// Archive and restore say how many children ride along, when any do; archive also that nothing is lost by it.
const familyRows = computed(() => (takesFamily.value ? [{ label: t(`agents.words.childAgents`), value: props.family ?? 0 }] : []));
const archiveHint = computed((): Tip => ({ title: t(`agents.agentCard.archive`), rows: familyRows.value, note: t(`agents.words.allKept`) }));
const restoreHint = computed((): TooltipValue => (takesFamily.value ? { title: t(`ui.action.restore`), rows: familyRows.value } : t(`ui.action.restore`)));
// The filter's own key for opening the card its id names, drawn as the key cap the tip wears.
const enterKey = formatChord(`enter`, isApplePlatform());
// Drill-in label, undefined for a draft (nothing to review); desktop only, since a mobile tap navigates there.
const review = computed(() => (mobile.value ? undefined : reviewAction(props.agent)));
// A turn a spent allowance stranded, sent again from the card: offered only where that is still the reader's press to
// make. Not once a resend or a move is booked, which goes by itself (limitScheduled: the card has left Attention for
// that reason, and its corner already says when it goes; the chat keeps its own press for going sooner). Not in the
// archive, where every press waits for a restore (a resend would un-archive it as a side effect, as a resolve would),
// and not on another sandbox's card: the resend addresses this sandbox's daemon, which holds no such turn.
const resendable = computed(
    () =>
        limited(props.agent) && props.agent.limitHeld === true && !limitScheduled(props.agent) && props.agent.archivedAt === undefined && localOnly.value,
);
// The drill-in is the Attention card's way on, spelled out in the summary row (a header icon on every other lane),
// unless Send again holds that seat. Nothing is lost there: a stranded card's drill-in is "Open chat" (drillTarget),
// exactly where a click on the card already goes, so it earns no header seat taken out of the title's width.
const rowDrill = computed(() => review.value !== undefined && lane.value === `attention` && !resendable.value);

// Asks laneDrop the same question the drag already answers, so a second reading can't disagree with it on the same
// card.
// Excludes archived cards: pressing this would quietly un-archive the agent (the daemon's registry.begin) as a side
// effect.
const resolvable = computed(() => props.agent.archivedAt === undefined && dropActionFor(props.agent, `finished`) === `resolve`);
// The other half of a refused land, and the reason `resolvable` can be false on a card that is plainly conflicted: no
// rebase reaches a file the user has uncommitted edits on, so the card says so in the same seat instead of offering the
// agent. Never both: `conflictIsYours` is exactly the case laneDrop withholds `resolve` for.
// A sentence, not a press: the card cannot commit those edits, and the daemon re-reads the refusal once they are
// committed, moving the card on by itself. The review panel's ladder, one click away, names the files.
const yoursToClear = computed(
    () => props.agent.archivedAt === undefined && (props.agent.attention.conflict || props.agent.status === `conflict`) && conflictIsYours(props.agent),
);
// The Sandbox pages that wrote every file of such a refusal, when one did: then the sentence names them, as the review does.
const settingsPages = useSettingsRefusal(() => props.agent, () => yoursToClear.value);
// Work this agent landed that's no longer in the tree; excluded in the archive, like every other press here (restore
// first).
// Takes the Ready button's slot: Land now would leave the discarded half missing (the hardest wrong to notice), so Land
// again replaces it when both apply. Named by who took it out when the sandbox could tell, and offering no Land again
// when that was an agent, whose doing it was on purpose (the card menu keeps it).
const away = computed(() => (props.agent.archivedAt === undefined ? landedAway(props.agent, user.value?.email) : undefined));
// What its last land did in the folder on the owner's computer, for a project folder attached to this computer's own
// sandbox (landedDelivery): a fact with no press, so the archive keeps it too.
const delivery = computed(() => landedDelivery(props.agent));
// Whether that line carries its press. One an agent took out carries none, so the card lands whatever is new as a Ready
// card would, leaving out what was taken, and reads as a receipt once there is nothing new.
const relandOffered = computed(() => away.value?.offerReland === true);
// The Ready card's press, offered because auto-land is off; same wording and mechanics as the review panel's own
// button.
// Excluded in the archive, like `resolvable`: restore first.
const landable = computed(() => props.agent.archivedAt === undefined && props.agent.status === `ready` && !relandOffered.value);
// The same block held open while the land it started runs: `ready` flips to `landing` on the press, and a button that
// vanishes under the click takes the card's only account of the land with it and shortens the card mid-press.
const shipping = computed(() => props.agent.archivedAt === undefined && props.agent.status === `landing` && !relandOffered.value);
// A RECEIPT: a finished card that asks nothing of anyone. It keeps every fact it had and spends none of the board's
// colour on them — the success green, the diff's red/green, the context tint all flatten to the row's own ink.
// Finished is the only lane that fills by itself, so on an ordinary board it is forty painted rows beside two lanes
// holding three cards each, and the eye went to the ledger because the ledger was the only column with colour in it.
// NOT every finished card qualifies, which is the whole point of asking rather than keying off the lane: `ready`
// still offers Land now, and landed-then-discarded work still says so in warning ink. Those are presses, not
// receipts, and a press that reads as quietly as a receipt is a press nobody makes.
// In the ARCHIVE that exception lapses: every press is withheld there until the card is restored (see `landable`,
// `away`, `resolvable`), so a `ready` card filed away has nothing to shout about and reads as the receipt it is.
// A land under way is a press in progress, not a receipt: flattening it would grey out the one spinner saying so.
const receipt = computed(
    () =>
        lane.value === `finished` &&
        (props.agent.archivedAt !== undefined || (props.agent.status !== `ready` && props.agent.status !== `landing` && !relandOffered.value)),
);
// Statuses whose ink is already quiet (`idle`, `resumed`, `stopped`) keep it: flattening those to `muted` would make
// a receipt LOUDER than it is today, which is the opposite of the errand.
const QUIET_INK: ReadonlySet<string> = new Set([`text-subtle`, `text-muted`]);
const statusMeta = computed(() => (receipt.value && !QUIET_INK.has(meta.value.class) ? { ...meta.value, class: `text-muted` } : meta.value));
// The two lanes about work in flight get the bigger card: a step up in title size and padding, so which lane a card
// is in is legible from its weight and not only from which column it landed in.
// Hierarchy through the CARD rather than through the column: widening Attention and Active instead would have bought
// nothing on an ordinary board, where those two lanes are near-empty and the widened columns are mostly air, and it
// would have taken the width out of the one lane whose rows are already tightest.
// Never in `dense` (the stacked, narrow board): there the lanes are stacked, so their order already says which is
// which, and the extra padding costs a card per screen where cards per screen is the scarce thing.
const live = computed(() => props.dense !== true && lane.value !== `finished`);
// An action of this card's own is in flight: every press that would start a second one is pressed out, since the
// daemon refuses it. Opening the card is not one of those — a transcript is readable while the work lands.
const busy = computed(() => props.pending !== undefined);
// True while this card's own land is pending; `pending` names the action so archiving doesn't leave Land spinning too.
// The daemon's own `landing` counts as well, so a land started in another window (or one whose request already answered
// while the lease is still held) reads as busy here rather than as a press the daemon would refuse.
const landing = computed(() => props.pending === `land` || props.agent.status === `landing`);
// Maintainers get Land now; collaborators get Request land instead, since the daemon floors landing at maintainer;
// viewers get neither.
// The request is sent here rather than emitted, since the board is only one of this card's several hosts.
const { canReview, canShip } = useRole();
// The audience's words for the verbs on this card; a maker also loses the branch and runner chips, which name nothing
// they chose.
const words = useVocabulary();
const { maker } = useAudience();
const { refresh: refreshAgents, notice: agentsNotice, rename } = useAgents();
const requesting = ref(false);
const requestLand = async (): Promise<void> => {
    if (requesting.value) {
        return;
    }
    requesting.value = true;
    try {
        await requestLandAgent(props.agent.id, props.agent.sandboxId);
        await (props.agent.sandboxId === undefined ? refreshAgents() : Promise.resolve(refreshAcross()));
    } catch (caught) {
        agentsNotice.value = messageOr(caught, t(`agents.agentCard.couldntSendLandRequest`));
    } finally {
        requesting.value = false;
    }
};
// The standing ask, worn for everyone: a collaborator sees it took, a maintainer reads it as the cue to land.
const landAsk = computed(() => {
    const request = props.agent.landRequested;
    return request === undefined ? undefined : t(`agents.agentCard.askedToLand`, { name: request.name ?? request.email });
});
// Its own flag, not a wider `landing`, so each button names only its own press; on an `away` card the daemon's
// `landing` is that press, whichever window made it.
const relanding = computed(() => props.pending === `reland` || (relandOffered.value && props.agent.status === `landing`));
// Gated on exactly what it renders, no more and no less: gating on a subset hides what should show, a superset opens an
// empty strip.
// The diff chip's own condition, not merely `diff exists`, since renames alone render nothing.
// Context is deliberately absent: it is a row of the identity tile's hover (see `tileHint`), so a card whose only stat
// was its context opens no summary row at all.
const stats = computed(
    () =>
        props.agent.costUsd !== undefined ||
        (props.agent.diff !== undefined && (props.agent.diff.insertions > 0 || props.agent.diff.deletions > 0)),
);
// THE IDENTITY TILE IS ALSO THE PROGRESS GAUGE. The kind-of-work glyph was doing one job, telling cards apart, and it
// did it in the strongest position a card has — leading, where the eye lands first — while the readings that say where
// a session has got to sat in the summary row, last, among four other stats. So the rim went around the tile, and
// `tileRim` draws one reading on it: the agent's own checklist, plus a segment for the session's ending, which is the
// whole rim for a session that kept no list. Context and cost stay off it: a fill percentage drawn as an arc read as
// unfinished work on every finished card, and "$3.26 of what?" has no denominator to draw against.
// Plain ink on a receipt, where the reading is history rather than a live gauge.
const rim = computed(() => tileRim(props.agent, { quiet: receipt.value }));
// One hover for a tile carrying the category as well, since two nested tooltips would raise two boxes over the same
// 28 pixels. Context fullness is said here and nowhere else on the card. Either half can be missing: a title the
// category reading declines still has its readings, and a fresh agent has a category and nothing measured yet. A
// reading not taken leaves its row empty and the card drops it.
const tileHint = computed((): TooltipValue => {
    const type = category.value?.type;
    const list = props.agent.checklist;
    const percent = contextPct(props.agent.contextTokens, props.agent.contextWindow);
    if (list === undefined && percent === undefined) {
        return type;
    }
    return {
        title: type ?? t(`agents.agentCard.progress`),
        rows: [
            { label: t(`agents.agentCard.steps`), value: list === undefined ? `` : `${Math.min(list.done, list.total)}/${list.total}` },
            { label: t(`agents.agentCard.context`), value: percent === undefined ? `` : `${percent}%` },
        ],
    };
});
const working = computed(() => turnWorking(props.agent));
// Whether the card can show a date at all: an untouched draft can't, and neither can a running turn, whose own elapsed
// readout takes the same slot.
const dated = computed(() => props.agent.archivedAt !== undefined || (!working.value && props.agent.updatedAt > 0));
// Whether a mark can be addressed to this card at all: a draft, a refused start or a chat reopened from history has no
// registry entry, so the daemon would answer a press with 404.
const reactable = computed(() => !unregistered(props.agent.status));
// The strip lives in the summary row and the press that opens its picker in the header, so the header reaches it here.
const reactionsStrip = useTemplateRef<{ open: (from: HTMLElement) => void }>(`reactionsStrip`);
// The card's own element: the permission row raises the held command off its hover.
const cardRoot = useTemplateRef<HTMLElement>(`cardRoot`);
// Whether the closing line has anything to show: gated on everything it draws, so a card with nothing here opens no
// empty strip.
// One wrapping line (stats left, press and time right) rather than two rows, so a lane fits more cards.
// No "Completed" here: the word was the drill-in's stand-in from when this row carried the drill-in on every lane, so
// once that moved to the header it said itself only where the drill-in was missing (any phone, a card with no branch),
// a coin toss of a label on forty receipts in a lane already named Finished, whose corner glyph says how each settled.
const summary = computed(() => stats.value || rowDrill.value || resendable.value || dated.value || working.value || reactable.value);
const loopLine = computed(() => (props.agent.loop === undefined ? undefined : loopMeta(props.agent.loop)));
// What its last turn showed of its own work (proofSeal.ts). Held while value-equal, so a roster frame that moved
// something else on this card (its activity, its clock) redraws none of the seal.
let heldPrint = ``;
let heldProof: ProofMark | undefined;
// A land that broke wears no seal: a check mark on the card whose work is stuck read as finished.
const landBroke = computed(() => landFailure(props.agent));
const failureLine = computed(() => (landBroke.value === undefined ? props.agent.failure : t(`agents.agentStatus.couldntLand`, { reason: landBroke.value })));
// The red line's raw sentence, for its hover: the land's own words where it broke, else the turn's. A land that broke
// keeps the line after the next turn cleared the turn's failure, since its work is still stuck (landFailure).
const failureRaw = computed(() =>
    landBroke.value !== undefined
        ? (props.agent.landFailure?.reason ?? props.agent.failure)
        : limited(props.agent) || memoryHeld(props.agent)
          ? undefined
          : props.agent.failure,
);
const proof = computed(() => {
    const next = landBroke.value === undefined ? cardProof(props.agent, turnInFlight(props.agent)) : undefined;
    const print = JSON.stringify(next ?? null);
    if (print !== heldPrint) {
        heldPrint = print;
        heldProof = next;
    }
    return heldProof;
});
// Where its last turn put its work besides its branch (reachLine.ts): live files, a clone of its own, a push. Kept
// while a new turn runs, unlike the seal: the work it names stays where it went until a turn puts it back.
const reach = computed(() => reachLine(props.agent.reach));
// THE SEAL IS THE CORNER'S LAST MARK, beside the chip or the status glyph, never under either: a card whose turn just
// ended is almost always unread, so a seal that gave way to "Updated" would hide exactly when its proof is news.
// It STANDS IN for a resting glyph (proofSeal.sealStandsIn); its hover leads with the word the glyph wore.
const sealStandsIn = computed(() => standsIn(proof.value, props.agent.status));
// Either mark opens the same question the chat's status bar asks, answered for this card.
const warmOpen = ref(false);
const warmAnchor = ref<HTMLElement>();
const openWarm = (event: MouseEvent): void => {
    warmAnchor.value = event.currentTarget as HTMLElement;
    warmOpen.value = true;
};
// Re-runs the exact held turn (useAgents.resumeHeldTurn), not a new message; a local flag, since `pending` names drop
// actions and this is neither.
// Cleared in `finally`, not only on success, since a roster frame is about to replace the card either way.
const resending = ref(false);
const sendAgain = async (): Promise<void> => {
    if (resending.value) {
        return;
    }
    resending.value = true;
    try {
        await useAgents().resumeHeldTurn(props.agent.id);
    } catch (caught) {
        // The card is left as it was and the words are still safe in the composer; the strip says why nothing moved.
        agentsNotice.value = messageOr(caught, t(`agents.agentCard.couldntSendAgain`));
    } finally {
        resending.value = false;
    }
};
// Says which provider runs it exactly once: while the tile wears the provider mark this needs no floor.
// Once the category glyph replaces that mark, a card with no recorded model would otherwise never say the provider at
// all.
const model = computed(() => {
    if (props.agent.model !== undefined) {
        return modelLabelFor(props.agent.provider, props.agent.model);
    }
    return category.value === undefined ? undefined : providerLabel(props.agent.provider);
});
// Which login actually served this turn (from the turn's own session frame), not the composer's current pick, which may
// differ after a mid-chat switch.
// The summary carries only a UUID; read against the window's account list, so an unresolvable id (disconnected login)
// draws nothing.
const account = computed(() => accountBadge(providerAccounts.value[props.agent.provider] ?? [], props.agent.account));
// A computed of its own, not a call in the template: `previewOf` reads every composer's words, and wrapping it here
// leaves Vue comparing one string, so only the card being typed into redraws.
const unsentWords = computed(() => previewOf(props.agent.id));
const displayTitle = computed(() => agentDisplayTitle(props.agent, unsentWords.value));
// Marks the filter term in the title; the matched line (via MatchLine, which also names the speaker) is never shown
// apart from it.
// Term is case-folded to match the filter's own rule, unless `Aa` (matchCase) is on.
const needle = computed(() => (props.matchCase === true ? (props.query ?? ``) : (props.query?.toLowerCase() ?? ``)));
const titleRuns = computed(() => markSegments(displayTitle.value, needle.value, props.matchCase === true));
// The identifier the filter matched, its matched part marked; ids have no case, so neither does the mark.
const idRuns = computed(() => (props.idMatch === undefined ? [] : markSegments(props.idMatch.text, props.idMatch.mark)));
// "New" already says unopened; "Updated" hides when you last looked, so only that one earns a hover hint: when.
const chipHint = computed(
    (): Tip | undefined =>
        chip.value?.hint ??
        (chip.value?.seenAt === undefined
            ? undefined
            : { title: t(`agents.agentCard.newActivity`), rows: [{ label: t(`agents.agentCard.lastOpened`), value: timeAgo(chip.value.seenAt, { days: true }) }] }),
);

const edit = createInlineRename(
    () => props.agent.title,
    (name) => rename(props.agent.id, name),
    t(`agents.agentCard.couldntRename`),
);
// A blur-commit click on the card body must commit the rename, not also open the agent.
// The event rides along since a modified click means something else on this board (a chat pane/column); a keyboard open
// carries none.
const openCard = (event?: MouseEvent): void => {
    if (edit.editing || edit.consumeSuppressedOpen()) {
        return;
    }
    emit(`open`, event);
};

// Never a side effect of a plain click: the drill-in and a desktop double-click fire this, and it goes where the drill-in's
// label says (useCardFocus.drillIn). A phone has no drill-in (`review` is undefined there), so a double-tap stays two taps.
const reviewCard = (): void => {
    if (edit.editing || review.value === undefined) {
        return;
    }
    emit(`review`);
};

// One shared class for the header's icon affordances (rename, archive, etc), differing only by glyph and opacity rule.
// Ink stays 20px, but `touch-target` widens the hit area to 44 on a coarse pointer, so four icons still fit a narrow
// row on a phone.
// Hover fill is an ink tint, not `bg-overlay`: these glyphs sit ON the card.
// A surface-named fill would vanish on a selected card (whose own fill is that overlay) and in the light scheme, where
// overlay equals card.
const HOVER_ACTION = `touch-target flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition hover:bg-content/10 hover:text-content`;
// Hidden until the card is hovered or one of them is focused, since at rest they are forty cards of glyphs; a phone has
// no hover, so what it keeps of them (one ⋯, or a lone press) stays drawn, quieter than the ink around it.
const actionClass = computed(() => `${HOVER_ACTION} ${mobile.value ? `opacity-60` : `opacity-0 focus-visible:opacity-100 group-hover:opacity-100`}`);

// Every press the header offers, in the order the row draws them. Keep leads, since it is the one with a deadline (the
// look closes on the next click elsewhere); the drill-in closes the row. Adding a mark rides with the card's other
// actions, not with the marks themselves: this row reserves its seats and lets the title take what is left, so
// revealing it resizes nothing, while the stats row below has no seat to spare.
const cardActions = computed((): ActionItem[] => {
    const actions: ActionItem[] = [];
    if (props.peek === true) {
        actions.push({
            id: `keep`,
            label: t(`chat.words.keepChatOpen`),
            icon: `pin`,
            hint: { title: t(`ui.action.keepOpen`), note: t(`agents.agentCard.closesWhenAnotherOpens`) },
            run: () => emit(`keep`),
        });
    }
    if (localOnly.value) {
        actions.push({ id: `rename`, label: t(`agents.agentCard.renameAgent`), icon: `pencil`, hint: t(`ui.action.rename`), disabled: busy.value, run: () => edit.begin() });
    }
    if (archivable.value) {
        actions.push({
            id: `archive`,
            label: t(`agents.agentCard.archiveAgent`),
            icon: `box`,
            hint: archiveHint.value,
            note: archiveHint.value.note,
            disabled: busy.value,
            run: () => emit(`archive`),
        });
    }
    if (closable.value) {
        actions.push({
            id: `close`,
            label: t(`agents.agentCard.closeAgent`),
            icon: `times`,
            hint: closeHint.value,
            note: closeHint.value.note,
            disabled: busy.value,
            run: () => emit(`close`),
        });
    }
    if (props.agent.archivedAt !== undefined) {
        actions.push({ id: `restore`, label: t(`agents.agentCard.restoreAgent`), icon: `undo`, hint: restoreHint.value, disabled: busy.value, run: () => emit(`restore`) });
    }
    if (reactable.value) {
        actions.push({ id: `react`, label: t(`agents.agentReactions.addReaction`), icon: `plus`, run: (from) => reactionsStrip.value?.open(from) });
    }
    // An icon, not a spelled-out link, so it costs no space at rest; the words move to the tooltip (and the sheet).
    if (review.value !== undefined && lane.value !== `attention`) {
        actions.push({ id: `review`, label: review.value, icon: `arrow-right`, run: () => reviewCard() });
    }
    return actions;
});

// Starts the drag only when the press begins on the card body; the rename pencil and its input run their own pointer
// gestures. The card moves by pointer and nothing native may start inside it (`@dragstart.prevent` on the root): a
// native drag of one of its selectable spans freezes the tab in Brave (brave/brave-browser#57753).
const grab = (event: PointerEvent): void => {
    // Primary button only: a right-press opens the card's menu, and dragging should not also start under it.
    if (event.button !== 0) {
        return;
    }
    // A drop is another action, so a card already running one is held still; the click that opens it still lands.
    if (busy.value) {
        return;
    }
    if (edit.editing || !(event.currentTarget instanceof HTMLElement) || !(event.target instanceof Element)) {
        return;
    }
    if (event.target.closest(`input, button`) !== null) {
        return;
    }
    // A modified press picks this card into a chat pane instead of dragging it, so the two gestures don't both fire.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
    }
    emit(`grab`, event, event.currentTarget);
};
</script>

<template>
    <div
        ref="cardRoot"
        role="button"
        tabindex="0"
        :aria-label="t(`agents.agentCard.focusAgent`, { displayTitle })"
        class="session-card group flex w-full select-none flex-col rounded-2xl border text-left focus-visible:ring-2 focus-visible:ring-primary-500/25"
        :class="[
            /* A LIVE CARD IS A BIGGER CARD (see `live`): the two lanes about work in flight get 16px of padding and a 14px title, the ledger keeps 14 and 12. */
            live ? 'gap-2.5 p-4' : 'gap-2 p-3.5',
            /* TWO STATES, TWO CHANNELS, AND NEITHER IS DRAWN HERE. */
            lane === 'attention' ? 'session-card-attention' : '',
            selected ? 'session-card-on' : '',
            /* The halo is an outline, which `outline-none` (a utility, so it outranks any component rule) would erase. */
            idMatch?.exact === true ? 'session-card-found' : 'outline-none',
            dragging ? 'opacity-40' : '',
        ]"
        @pointerdown="grab"
        @dragstart.prevent
        @click="openCard"
        @dblclick="reviewCard"
        @keydown.enter.self.prevent="openCard()"
        @keydown.space.self.prevent="openCard()"
    >
        <div class="flex items-center gap-2.5">
            <!-- Kind-of-work glyph tinted by the title's category (sessionCategory: audit=blue magnifier, redesign=purple arrows, new=green plus, fix=red wrench). -->
            <span v-tooltip.top="tileHint" class="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full">
                <!-- A tick per checklist item and one for the session's ending, closed once it is finished (`tileRim`). -->
                <SegmentRing :segments="rim.segments" :filled="rim.filled" :size="28" :stroke="1.5" class="absolute inset-0" :class="rim.tone" />
                <IdentityTile :title="agent.title" :action="agent.titleAction" :provider="agent.provider" class="h-5.5 w-5.5 text-xs" />
            </span>
            <input
                v-if="edit.editing"
                v-model="edit.draft"
                type="text"
                maxlength="80"
                :aria-label="t(`agents.words.agentTitle`)"
                class="ui-field-box ui-field-inline min-w-0 flex-1 select-text px-1 font-semibold"
                :class="live ? 'text-sm' : 'text-xs'"
                @click.stop
                @keydown.enter.stop.prevent="edit.commit()"
                @keydown.esc.stop.prevent="edit.cancel()"
                @blur="edit.blurCommit()"
                @vue:mounted="edit.focusInput"
            />
            <template v-else>
                <!-- A LIVE CARD'S TITLE WRAPS, a receipt's clips. -->
                <span
                    class="min-w-0 flex-1 font-semibold text-content"
                    :class="[live ? 'line-clamp-2 break-words text-sm leading-snug' : 'truncate text-xs', peek ? 'italic' : '']"
                >
                    <span v-for="(run, at) in titleRuns" :key="at" :class="run.hit ? 'rounded-sm bg-primary-600/30 text-content' : ''">{{
                        run.text
                    }}</span>
                    <!-- Italic is invisible to a screen reader, so the peek state rides along as text, not an aria-label with no role. -->
                    <span v-if="peek" class="sr-only">{{ t(`agents.agentCard.temporary`) }}</span>
                </span>
                <!-- The card's own presses (cardActions), revealed on hover where there is a pointer and folded behind one ⋯ on a phone. -->
                <OverflowActions :actions="cardActions" :button-class="actionClass" :header="displayTitle" />
            </template>
            <!-- Same pill, same tones, same precedence as a rail row's corner (RailCard): one standing, one reading. -->
            <span
                v-if="chip !== undefined"
                v-tooltip.top="chipHint"
                class="ui-status-pill shrink-0 gap-1 text-2xs font-semibold"
                :class="chip.tone"
                ><Icon v-if="chip.family" name="subagents" class="shrink-0 text-2xs" />{{ chip.label }}</span
            >
            <!-- The resting standing for a card with no reason or unread mark; carries meta.label as a word in its hover, not just a glyph. -->
            <!-- What the last turn left open is the tile rim's to say (tileRim): the checklist it drew here twice was one fact with two marks. -->
            <Icon
                v-else-if="!sealStandsIn"
                :name="statusMeta.icon"
                :spin="statusMeta.spin"
                v-tooltip.top="statusMeta.label"
                :aria-label="statusMeta.label"
                role="img"
                class="shrink-0 text-sm"
                :class="statusMeta.class"
            />
            <!-- What its last turn showed of its own work, one glyph, its words in its hover (CardSeal). -->
            <CardSeal v-if="proof !== undefined" :proof="proof" :quiet="receipt" :status="sealStandsIn ? statusMeta.label : undefined" class="text-sm" />
        </div>
        <p v-if="edit.error !== undefined" class="text-2xs text-danger">{{ edit.error }}</p>

        <!-- Card body, column or row depending on `dense`: column stacks one block per row; row wraps the same blocks along one line. -->
        <div :class="dense ? 'flex flex-wrap items-center gap-x-3.5 gap-y-1.5' : 'flex flex-col gap-2'">
            <!-- Why this card matched the filter; leads the body while a filter is active. An id is its own evidence, since nothing the card says holds it: spelled as typed, in the id's own face, and named whole when it is. -->
            <p
                v-if="idMatch !== undefined"
                class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted"
                :class="dense ? 'w-full' : ''"
            >
                <Icon name="search" class="shrink-0 text-2xs text-subtle" />
                <span class="min-w-0 truncate font-mono">
                    <span v-for="(run, at) in idRuns" :key="at" :class="run.hit ? 'rounded-sm bg-primary-600/30 text-content' : ''">{{
                        run.text
                    }}</span>
                </span>
                <span
                    v-if="idMatch.exact"
                    v-tooltip.top="{ title: t(`ui.action.open`), keys: enterKey }"
                    class="ui-status-pill shrink-0 bg-primary-600/20 py-px font-semibold text-link"
                    >{{ t(`agents.agentCard.exactId`) }}</span
                >
            </p>
            <p v-else-if="match !== undefined" class="flex min-w-0 items-start gap-2 text-2xs text-muted" :class="dense ? 'w-full' : ''">
                <Icon name="search" class="mt-px shrink-0 text-2xs text-subtle" />
                <MatchLine :snippet="match" :needle="needle" :match-case="matchCase" class="line-clamp-2 min-w-0 flex-1 leading-4" />
            </p>

            <!-- `failure` is present only while the card reads as failed, so no extra status check is needed here. -->
            <!-- A broken land in plain words; git's own sentence stays in the hover for whoever fixes it. -->
            <p v-if="failureRaw" class="flex min-w-0 items-start gap-2 text-2xs text-danger" v-tooltip.top="failureRaw">
                <Icon name="exclamation-circle" class="mt-px shrink-0 text-2xs" />
                <span class="line-clamp-2 min-w-0 flex-1 leading-4">{{ failureLine }}</span>
            </p>

            <!-- Where its last turn's work went besides its branch: the worst of it in one line, every place in the hover. -->
            <p
                v-if="reach !== undefined"
                class="flex min-w-0 items-start gap-2 text-2xs"
                :class="reach.tone === `warning` ? 'text-warning' : 'text-muted'"
                data-reach
                v-tooltip.top.lines="reach.detail"
            >
                <Icon :name="reach.tone === `warning` ? `exclamation-triangle` : `cloud-upload`" class="mt-px shrink-0 text-2xs" />
                <span class="line-clamp-2 min-w-0 flex-1 leading-4">{{ reach.text }}</span>
            </p>

            <!-- Provenance, ahead of the model/branch line: for an agent the user didn't start, whose it is outranks what it runs on. -->
            <OriginMark :origin="agent.origin" />
            <WorkflowMark :workflow="agent.workflow" />
            <ParentMark v-if="parent !== undefined" :parent="parent" :sandbox-id="agent.sandboxId" />

            <!-- WRAPS, which is what lets the unsent mark ride this line instead of taking one of its own. -->
            <div
                v-if="
                    agent.unsent ||
                    box !== undefined ||
                    provenance !== undefined ||
                    model !== undefined ||
                    agent.branch !== undefined ||
                    (account !== undefined && !mobile)
                "
                class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-subtle"
            >
                <!-- Shape and wording live in UnsentMark, shared with the rail row. -->
                <UnsentMark v-if="agent.unsent" :preview="unsentWords" :at="agent.draftAt" />
                <!-- Which sandbox this agent is in, shown only when it isn't the reader's own; leads the line since it changes what every other number means. -->
                <span
                    v-if="box !== undefined"
                    class="flex min-w-0 shrink-0 items-center gap-1 truncate rounded bg-content/10 px-2.5 py-1 text-muted"
                    v-tooltip.top="{ title: t(`agents.words.otherSandbox`), rows: [{ label: t(`agents.words.sandbox`), value: box.name }] }"
                >
                    <SandboxLogo :size="12" :image="box.image ?? null" :name="box.name" />
                    <span class="truncate">{{ box.name }}</span>
                </span>
                <!-- Whose it is leads what it runs on: for a card that isn't the reader's own, that outranks the model. -->
                <OwnerMark v-if="provenance !== undefined" :mark="provenance" />
                <span v-if="model !== undefined" class="inline-flex min-w-0 items-center gap-1.5">
                    <span v-if="provenance !== undefined">·</span>
                    <span class="truncate">{{ model }}</span>
                </span>
                <!-- Where it's running, shown only when that's somewhere other than here: the fleet spreads work across machines without a per-agent choice. -->
                <span
                    v-if="agent.runner !== undefined && !maker"
                    class="flex shrink-0 items-center gap-1 truncate"
                    v-tooltip.top="{ title: t(`agents.agentCard.runner`), rows: [{ label: t(`agents.agentCard.machine`), value: agent.runner }] }"
                >
                    <Icon name="desktop" class="text-2xs" />
                    {{ agent.runner }}
                </span>
                <!-- Abbreviated on the card, full string on hover; a label, not a control (copy is on the right-click menu). -->
                <!-- Clipped on the card, full identity on hover; nothing renders if the sandbox can't name the account. -->
                <span v-if="agent.branch !== undefined && !maker" class="inline-flex min-w-0 items-center gap-1.5">
                    <span v-if="model !== undefined || provenance !== undefined">·</span>
                    <SessionChip :branch="agent.branch" />
                </span>
                <!-- Not on a phone: which login served the turn is the line's least-read fact, and on a phone's width it was the one that broke the line in two. -->
                <span v-if="account !== undefined && !mobile" class="inline-flex min-w-0 shrink items-center gap-1">
                    <span v-if="model !== undefined || provenance !== undefined || (agent.branch !== undefined && !maker)">·</span>
                    <span v-tooltip.top="account.hint" class="inline-flex min-w-0 shrink items-center gap-1">
                        <Icon name="user" class="shrink-0 text-2xs" />
                        <span class="truncate">{{ account.label }}</span>
                    </span>
                </span>
            </div>

            <!-- Never replaces the live readout below: this says what the loop is working toward, that says what it's doing right now. -->
            <p v-if="agent.loop !== undefined" class="flex min-w-0 items-center gap-1.5 text-2xs" :class="loopLine?.class">
                <Icon name="repeat" :spin="loopLine?.spin" class="shrink-0 text-2xs" />
                <span class="truncate">{{ loopLine?.text }}</span>
            </p>

            <!-- A permission its turn waits on, answered here: the reply floor is a collaborator's, as in the chat. -->
            <CardPermissionAsk v-if="canReview" :agent="agent" :disabled="busy" :card="cardRoot ?? undefined" />

            <!-- The one board state that's a decision, not a report: the agent redoes the merge in its own worktree, so a wrong answer costs nothing. -->
            <div v-if="resolvable" class="flex min-w-0 flex-col gap-1">
                <!-- No in-flight face: the press moves the card to Active at once, taking this block with it. -->
                <Button size="small" :disabled="busy" class="self-start whitespace-nowrap" @click.stop="emit('resolve')">
                    <Icon name="sparkles" />{{ words.resolveConflict }}
                </Button>
                <span class="text-2xs leading-snug text-subtle">{{ words.resolveConflictHint }}</span>
            </div>

            <!-- Same seat, the refusals the agent cannot touch: a fact, not a press. Nothing on the card can commit the edits in its way, a button that only changed the view read as one that did nothing, and the card leaves this seat by itself once they are committed. The footer's review link names the files. -->
            <p v-else-if="yoursToClear" class="flex min-w-0 items-start gap-1.5 text-2xs leading-snug text-muted">
                <Icon name="file-edit" class="mt-0.5 shrink-0 text-2xs text-warning" /><span class="min-w-0">{{
                    settingsPages === undefined ? words.clearYoursHint : t(`agents.agentCard.settingsNotSaved`, { pages: settingsPages })
                }}</span>
            </p>

            <!-- One row (fact left, press right), not a stack: this is a fact the card owes the reader regardless of action, unlike the decision blocks above. -->
            <div v-if="away !== undefined" class="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
                <!-- Muted when an agent took it out: a fact about its own tidying, not a press this card owes anyone. -->
                <span
                    v-tooltip.top="away.tip"
                    class="inline-flex shrink-0 items-start gap-1.5 text-2xs leading-snug"
                    :class="away.offerReland ? `text-warning` : `text-muted`"
                >
                    <Icon :name="away.icon" class="mt-0.5 shrink-0 text-2xs" /><span class="min-w-0"
                        >{{ away.text
                        }}<template v-if="away.hint !== undefined">
                            <span class="text-subtle"> ({{ away.hint }})</span></template
                        ></span
                    >
                </span>
                <!-- No resting glyph: the line above it already leads with this exact icon, and a repeat would read as a stutter. -->
                <Button
                    v-if="away.offerReland"
                    size="small"
                    tier="quiet"
                    :disabled="busy || relanding"
                    v-tooltip.top="{ title: words.landAgain, note: t(`agents.agentCard.landAgainHint`) }"
                    class="shrink-0 whitespace-nowrap"
                    @click.stop="emit('reland')"
                >
                    <Icon v-if="relanding" name="spinner" spin class="text-2xs" />{{ relanding ? words.landing : words.landAgain }}
                </Button>
            </div>

            <!-- What the land did in the owner's own folder: warm only where they have something to look at or do, and the paths it kept out in the hover. -->
            <p
                v-if="delivery !== undefined"
                v-tooltip.top="delivery.tip"
                class="flex min-w-0 items-start gap-1.5 text-2xs leading-snug"
                :class="delivery.warm ? `text-warning` : `text-muted`"
            >
                <Icon :name="delivery.icon" class="mt-0.5 shrink-0 text-2xs" /><span class="line-clamp-2 min-w-0">{{ delivery.text }}</span>
            </p>

            <!-- Success-styled with the check glyph, matching the review panel's own Land now: the same action on the same work must read as such. -->
            <div v-if="(landable || shipping) && canShip" class="flex min-w-0 flex-col gap-1">
                <!-- The standing ask leads the button it's about, so a maintainer meets the reason before the press. -->
                <p v-if="landAsk" class="flex min-w-0 items-start gap-1.5 text-2xs leading-snug text-warning">
                    <Icon name="clock" class="mt-0.5 shrink-0 text-2xs" /><span class="min-w-0">{{ landAsk }}</span>
                </p>
                <!-- Disabled while the land runs: the daemon refuses a second one outright (agents.routes CONFLICT). -->
                <div class="flex items-center gap-1.5">
                    <Button
                        size="small"
                        tone="success" thumb
                        :disabled="landing || busy"
                        class="self-start whitespace-nowrap"
                        @click.stop="emit('land')"
                    >
                        <Icon :name="landing ? 'spinner' : 'check'" :spin="landing" />{{ landing ? words.landing : words.land }}
                    </Button>
                    <!-- Getting started's mark for the first land, beside the press that does it (only while that is the step). -->
                    <TourMark v-if="!landing" step="land" place="card" :priority="3" side="bottom" @click.stop />
                </div>
            </div>

            <!-- The same Ready card for a collaborator: land is a maintainer's press, so this offers the ask instead, same spot and size but quieter chrome. -->
            <div v-else-if="landable && canReview" class="flex min-w-0 flex-col gap-1">
                <p v-if="landAsk" class="flex min-w-0 items-start gap-1.5 text-2xs leading-snug text-muted">
                    <Icon name="clock" class="mt-0.5 shrink-0 text-2xs" /><span class="min-w-0">{{
                        t(`agents.agentCard.waitingMaintainer`, { landAsk })
                    }}</span>
                </p>
                <template v-else>
                    <Button size="small" tier="boring" :disabled="busy" class="self-start whitespace-nowrap" @click.stop="requestLand">
                        <Icon :name="requesting ? 'spinner' : 'send'" :spin="requesting" />{{
                            requesting ? t(`agents.agentCard.asking`) : words.requestLand
                        }}
                    </Button>
                    <span class="text-2xs leading-snug text-subtle">{{ words.requestLandHint }}.</span>
                </template>
            </div>

            <!-- The closing summary line: counted stats, then the drill-in and time held to the line's right (see `summary`). -->
            <div
                v-if="summary"
                class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-2xs text-muted"
                :class="dense ? 'min-w-32 flex-1' : ''"
            >
                <!-- No hover labels: a stat you can't name from its icon doesn't belong in this row. -->

                <!-- Red and green only while the diff is a live signal. -->
                <span v-if="agent.diff !== undefined && (agent.diff.insertions > 0 || agent.diff.deletions > 0)" class="font-mono">
                    <span :class="receipt ? '' : 'text-success'">+{{ agent.diff.insertions }}</span>
                    <span :class="receipt ? '' : 'text-danger'"> −{{ agent.diff.deletions }}</span>
                </span>
                <!-- Lifetime cost total, read-only here. -->
                <span v-if="agent.costUsd !== undefined">{{ formatMoney(agent.costUsd) }}</span>
                <!-- Opt-in geek metrics, beside what it cost: what its processes hold now. Draws only when the board provides a reading naming this conversation, so never for another box's card. -->
                <SessionMetrics v-if="localOnly" :conversation-id="agent.id" />
                <!-- The agents it started, counted, live-of-total while any work: the list itself opens under the card only while it is the one being looked at (ChildRows). -->
                <ChildCount :agent="agent" />
                <!-- Marks people left, at the end of the counted stats rather than in a row of their own, and drawn only when there are some: a strip that came and went with the pointer would resize every card it is on and flicker the lane around it. The press that adds one is in the header, with the card's other actions. -->
                <AgentReactions
                    v-if="reactable"
                    ref="reactionsStrip"
                    :agent-id="agent.id"
                    :reactions="agent.reactions"
                    :sandbox-id="agent.sandboxId"
                    :dense="true"
                />

                <!-- Press and clock take the line's leftover width, right-aligned. Sized from zero, floored at their fixed parts: the running command's words are contained (AgentCardClock), so a long command truncates here instead of pushing the corner onto a row of its own. -->
                <span class="inline-flex min-w-max flex-[1_1_0] items-center justify-end gap-2 text-subtle">
                    <!-- A stranded turn's own press, in the drill-in's seat (see `resendable`). It acts in place, so it is a text action leading with what it does, not a link trailing the arrow that marks the drill-in as a way somewhere else. -->
                    <button
                        v-if="resendable"
                        type="button"
                        :class="ui.textButton({ tone: `quiet` }, 'inline-flex shrink-0 font-medium')"
                        :disabled="resending || busy"
                        v-tooltip.top="{ title: t(`agents.agentCard.sameTurn`), note: t(`agents.agentCard.notNewMessage`) }"
                        @click.stop="sendAgain"
                    >
                        <Icon :name="resending ? `spinner` : `refresh`" :spin="resending" class="text-2xs" />{{
                            resending ? t(`ui.status.sending`) : t(`agents.words.sendAgain`)
                        }}
                    </button>
                    <button
                        v-else-if="rowDrill"
                        type="button"
                        class="inline-flex shrink-0 items-center gap-1 rounded font-medium text-link hover:underline"
                        @click.stop="reviewCard"
                    >
                        {{ review }}<Icon name="arrow-right" class="text-2xs" />
                    </button>
                    <!-- The one part of the card that moves with the clock, so a tick redraws it and not the card around it. -->
                    <AgentCardClock
                        :agent="agent"
                        :working="working"
                        :activity-text="activityText"
                        :busy="busy"
                        @unwatch="emit(`unwatch`)"
                        @stop-job="(jobId) => emit(`stopJob`, jobId)"
                        @warm="openWarm"
                    />
                </span>
            </div>
        </div>
        <ResponsiveOverlay v-model="warmOpen" :anchor="warmAnchor" cross="end" :header="t(`agents.keepWarm.title`)" panel-class="w-80">
            <KeepWarmPanel :agent="agent" @done="warmOpen = false" />
        </ResponsiveOverlay>
    </div>
</template>
