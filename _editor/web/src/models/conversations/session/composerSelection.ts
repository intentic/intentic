import { capabilitiesOf, clampMode, fastAllowed, loopLabel, loopOf, providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import type { AgentProvider, PermissionMode } from "@intentic/sandbox-contract/schemas/agent";
import { SPENT_UTILIZATION } from "@intentic/sandbox-contract/models/plan-pools";
import { t } from "@intentic/ui/i18n";
import { computed, shallowRef } from "vue";
import { providerAccounts } from "../../providers/providerAccounts";
import { modelLabelFor, providerModels } from "../../providers/providerCatalog";
import { servingAccount } from "../accounts/servingAccount";
import { clampEffort } from "../../providers/effortScale";
import { rememberedHarnessFor, rememberedModelFor, rememberedProviderFor, rememberHarness, rememberPick, turnDefaults } from "../run/turnDefaults";
import { accountIntent, readsAsContinuing, type SessionRef, type TurnSettings } from "../run/turnRequest";
import type { Conversation } from "./conversation";
import { type PickAction, type PickEffects, type PickWorld, reduceSelection, type Selection, UNPICKED } from "./selectionReducer";
import type { TranscriptView } from "./transcriptView";
import type { TurnClient } from "./turnClient";
import { accountFacts, accountState, formatRemaining, formatReset, isStale, modelAllowance, usageStatusFor } from "../../providers/usageStatus";

// A conversation's selection as the composer binds it: the value `reduceSelection` moves, read one pick at a time, and
// the one "switched" divider a change of it owes the transcript. Which picks a switch retires is the reducer's rule;
// what the divider says is the pure functions below; this class only carries out what a pick asks of the world.

// Which part of a switch retires the session, named as the reader picked it: another provider, another account on the
// same one, or another loop for the same account.
export type SegmentSwitch = `provider` | `account` | `loop`;

// Where a switch is measured from: what the chat has done so far and what the selection now is.
export interface SwitchPoint {
    // Anything has happened on this chat: a row on screen, or a session held.
    readonly started: boolean;
    // The held session still reads as matching the selection, so the next turn should resume it: the divider's words
    // only, since which session a turn goes on in is the daemon's to say.
    readonly resumes: boolean;
    // What the selection changed that the held session cannot carry; read only once it no longer resumes.
    readonly segment: SegmentSwitch;
    // The provider as the picker heads its list (Claude Code, Codex): the name the placeholder and the list both use.
    readonly providerLabel: string;
    // The account the next turn runs on, by its row's name in the picker; undefined when no row names it.
    readonly accountLabel: string | undefined;
    // The loop the next turn runs through, as the Run through menu names it.
    readonly loopLabel: string;
    // The model the last sent turn went out under; undefined before any, or once the segment was cut.
    readonly sentModel: string | undefined;
    readonly model: string;
    readonly modelLabel: string;
    // Whose allowance the model spends, when the plan meters it separately (` · 5h 87% used`), else empty.
    readonly allowance: string;
    // Messages already waiting in the queue (held, or booked for later). Each carries the provider and model it was
    // written under and goes out on them by itself; only a press that sends it now sends it on the new pick.
    readonly waiting: number;
}

// Said under a provider, loop or model switch while messages wait, since the divider sits right above them and its
// "your next message" would otherwise read as covering them. Not under an account switch: the daemon moves the
// conversation to the new account, and waiting messages go there with it.
const waitingNote = (point: SwitchPoint): string =>
    point.waiting === 0 ? `` : ` ${t(`chat.composerSelection.waitingKeepTheirs`, { count: point.waiting }, point.waiting)}`;

// The words for what retired the session. An account the picker has no row for is said as its provider, as before.
const segmentWords = (point: SwitchPoint): string => {
    if (point.segment === `account` && point.accountLabel !== undefined) {
        return t(`chat.composerSelection.switchedAccount`, { account: point.accountLabel });
    }
    if (point.segment === `loop`) {
        return `${t(`chat.composerSelection.switchedLoop`, { loop: point.loopLabel })}${waitingNote(point)}`;
    }
    return `${t(`chat.composerSelection.switchedProvider`, { provider: point.providerLabel })}${waitingNote(point)}`;
};

// A provider, account or harness switch retires the session; unconditional about what carries over, since that is the
// daemon's own record, not what this window happens to have painted. It names the part that changed: an account switch
// said as "Switched to Claude" named the provider the chat was already on.
export const segmentSwitchText = (point: SwitchPoint): string | undefined => (!point.started || point.resumes ? undefined : segmentWords(point));

// A model swap keeps the session and still costs something: it re-reads the whole conversation on a cold cache.
// Nothing sent yet on this segment, or the pick back where the last turn left it, says nothing.
export const modelSwitchText = (point: SwitchPoint): string | undefined =>
    point.sentModel === undefined || point.sentModel === point.model
        ? undefined
        : `${t(`chat.composerSelection.switchedModel`, { model: point.modelLabel })}${point.allowance}${waitingNote(point)}`;

// What the selection moved off the held session: its provider first, then its account, else the loop, which is the only
// other thing readsAsContinuing weighs. No session at all is a provider's first segment, said as the provider.
const segmentOf = (session: SessionRef | undefined, next: { readonly provider: AgentProvider; readonly account: string | undefined }): SegmentSwitch => {
    if (session === undefined || session.provider !== next.provider) {
        return `provider`;
    }
    return next.account !== undefined && next.account !== session.account ? `account` : `loop`;
};

// The pending divider's words while settings change; undefined retracts it.
export const switchNoticeText = (point: SwitchPoint): string | undefined => segmentSwitchText(point) ?? modelSwitchText(point);

// The divider a turn's settle owes for switches made while it ran; a segment switch counts only when one was made,
// since a sessionless provider would otherwise always look switched.
export const midTurnSwitchText = (point: SwitchPoint, switchedMidTurn: boolean): string | undefined =>
    (switchedMidTurn ? segmentSwitchText(point) : undefined) ?? modelSwitchText(point);

// How far a booking's instant may sit from an allowance's reopen and still be the booking made for it.
const REOPEN_MATCH_MS = 60_000;

// What a selection reads and writes of the conversation around it.
type SelectionHost = Pick<Conversation, "session" | "registered" | "activeModel" | "contextUsage" | "fastMode" | "box" | "peek" | "queue"> & {
    readonly transcript: Pick<TranscriptView, "messages" | "notice" | "rewordNotice" | "write">;
    readonly turn: Pick<TurnClient, "streaming" | "generating" | "moveAccount">;
};

export class ComposerSelection {
    // The selection, whole; `apply` is the one thing that replaces it.
    readonly state = shallowRef<Selection>(UNPICKED);

    // One read per pick, so a surface drawing one of them redraws only when that one moves.
    readonly provider = computed(() => this.state.value.provider);
    readonly harness = computed(() => this.state.value.harness);
    readonly account = computed(() => this.state.value.account);
    readonly model = computed(() => this.state.value.model);
    readonly movedFrom = computed(() => this.state.value.movedFrom);
    readonly displacedModel = computed(() => this.state.value.displacedModel);
    readonly thinking = computed(() => this.state.value.thinking);
    readonly fast = computed(() => this.state.value.fast);
    // Whether Auto's question is still open on this chat: nothing has gone to the sandbox under it yet. A chat it holds
    // (registered), one with a session, and one whose first message already waits in its queue (booked for later, held)
    // each already has the model it runs on; the reading only ever happens on a chat's first send (chatRoute.ts).
    readonly autoOpen = computed(
        () => !this.host.registered.value && this.host.session.value === undefined && (this.host.queue.value?.items.length ?? 0) === 0,
    );
    // Auto as this chat stands, not as the pick was stored. The pick is seeded from the next new chat's default, so a
    // chat opened from its card after Auto was armed anywhere was drawn on Auto, with its accounts and effort hidden, over
    // a turn that ran (and would run again) on the model it already had.
    readonly auto = computed(() => this.state.value.auto && this.autoOpen.value);
    readonly autoPicked = computed(() => this.state.value.autoPicked);
    readonly actsAs = computed(() => this.state.value.actsAs);
    readonly startIn = computed(() => this.state.value.startIn);
    readonly effortPick = computed(() => this.state.value.effortPick);
    readonly modePick = computed(() => this.state.value.modePick);

    // What this provider/harness pair can actually do (capabilitiesOf), the record the daemon plans the turn against.
    readonly capabilities = computed(() => capabilitiesOf(this.provider.value, this.harness.value));

    // Whether the running turn can absorb a mid-flight message; used only for wording ("steer" vs "queue").
    readonly steerable = computed(() => this.capabilities.value.steering);

    // Whether the fast control is offered at all (runtime, route, model must all allow it); the pick stays untouched.
    readonly fastOffered = computed(() =>
        fastAllowed(
            this.capabilities.value,
            this.provider.value,
            (providerModels.value[this.provider.value] ?? []).find((option) => option.value === this.model.value)?.badges,
        ),
    );

    // Effort the next turn actually runs at: the pick clamped to what the current provider+model+thinking triple offers.
    readonly effort = computed<string>(() => clampEffort(this.effortPick.value, this.provider.value, this.model.value, this.thinking.value));

    // Posture the next turn starts in: the pick clamped to what this conversation's runtime can hold.
    readonly mode = computed<PermissionMode>(() => clampMode(this.modePick.value, this.capabilities.value));

    // Whether the next turn names `account`, by the very rule its request is built with (accountIntent), or leaves it to
    // the daemon's record of where the conversation runs.
    readonly accountNamed = computed(
        () =>
            accountIntent(
                { agent: this.provider.value, account: this.account.value, accountPicked: this.state.value.accountPicked },
                { registered: this.host.registered.value, session: this.host.session.value },
            ) !== undefined,
    );

    // The account the next turn runs on (servingAccount), judged for this selection's model, for a surface that names it
    // without drawing the list (the pane's reconnect notice). The picker ticks the same row by the same rule over the same
    // rows, fed `account` and `accountNamed`, so neither can name an account the turn then does not run on.
    readonly servingAccount = computed(() =>
        servingAccount(this.provider.value, this.accountRows.value, { account: this.account.value, named: this.accountNamed.value }),
    );

    // That account's verdict for this selection's model, off the same rows: what the composer reads to know a press would
    // only meet a spent allowance (composerIntent's `scheduled`).
    readonly servingState = computed(() => this.accountRows.value.find((row) => row.id === this.servingAccount.value?.id)?.state);

    // The account on this chat's provider whose spent allowance reopens at `at` (ms), if one does: what a message booked
    // for a reopen waits on, read back off its instant, since the queue keeps no reason for a booking. The composer books
    // at the reopen itself (composerIntent's `scheduled`), so a minute either side is the same booking.
    spentReopeningAt(at: number): string | undefined {
        return this.accountRows.value.find(
            (row) => row.state.kind === `spent` && row.state.reopensAt !== undefined && Math.abs(row.state.reopensAt * 1_000 - at) <= REOPEN_MATCH_MS,
        )?.id;
    }

    private readonly accountRows = computed(() => {
        const provider = this.provider.value;
        const model = this.model.value === `` ? undefined : { id: this.model.value };
        return (providerAccounts.value[provider] ?? []).map((entry) => ({
            id: entry.id,
            state: accountState(provider, accountFacts(entry), model),
        }));
    });

    // The one unsent "switched" divider notice, upserted/removed as settings toggle, frozen by the next send.
    private pendingSwitchNoticeId: number | undefined;

    // What an untouched chat starts on: the last deliberate pick, resolved against what this sandbox can run.
    constructor(private readonly host: SelectionHost) {
        this.apply({ kind: `seed` });
    }

    // The one way the selection changes: the reducer decides, and what the pick asks of the world beyond it happens here.
    apply(action: PickAction): void {
        const { selection, effects } = reduceSelection(this.state.value, action, this.world());
        this.state.value = selection;
        this.remember(effects);
        if (effects.kept === true) {
            this.host.peek.value = false;
        }
        if (effects.segmentCut === true) {
            this.host.activeModel.value = null;
            this.host.contextUsage.value = undefined;
        }
        if (effects.fastStale === true) {
            this.host.fastMode.value = undefined;
        }
        if (effects.switchAccount !== undefined) {
            this.host.turn.moveAccount(effects.switchAccount);
        }
        if (effects.session !== undefined) {
            this.host.session.value = effects.session;
        }
        this.divide(effects.divider);
    }

    // Turn settings a message sends under: this selection as it stands at delivery, not at typing time, which spends the
    // one-turn Auto mark (it belongs to the turn the judge decided, and the next one on the same model is the user's). A
    // hand pick of an account rides along (`accountPicked`) and stays until a turn naming it starts (`accountTaken`).
    turnSettings(): TurnSettings {
        const { state } = this;
        const settings: TurnSettings = {
            agent: state.value.provider,
            harness: state.value.harness,
            account: state.value.account,
            actsAs: state.value.actsAs,
            startIn: state.value.startIn,
            model: state.value.model,
            effort: this.effort.value,
            thinking: state.value.thinking,
            // The pick AND the offer: a toggle left on must not ride to a model that doesn't publish fast mode.
            fast: state.value.fast && this.fastOffered.value,
            ...(state.value.autoPicked ? { autoPicked: true } : {}),
            accountPicked: state.value.accountPicked,
        };
        this.apply({ kind: `settingsTaken` });
        return settings;
    }

    // What the reducer may read of the world, as it stands at this pick.
    private world(): PickWorld {
        return {
            streaming: this.host.turn.streaming.value,
            generating: this.host.turn.generating.value,
            session: this.host.session.value,
            local: this.host.box.value === undefined,
            rememberedModel: rememberedModelFor,
            rememberedHarness: rememberedHarnessFor,
            defaults: () => {
                const provider = rememberedProviderFor();
                return {
                    provider,
                    picked: turnDefaults.provider.value,
                    harness: rememberedHarnessFor(provider),
                    effort: turnDefaults.effort.value,
                    thinking: turnDefaults.thinking.value,
                    auto: turnDefaults.auto.value,
                };
            },
        };
    }

    // The next new chat's defaults, as a pick leaves them.
    private remember({ remember, defaults = {} }: PickEffects): void {
        if (remember !== undefined) {
            rememberPick(remember);
        }
        if (defaults.effort !== undefined) {
            turnDefaults.effort.value = defaults.effort;
        }
        if (defaults.thinking !== undefined) {
            turnDefaults.thinking.value = defaults.thinking;
        }
        if (defaults.auto !== undefined) {
            turnDefaults.auto.value = defaults.auto;
        }
        if (defaults.harness !== undefined) {
            rememberHarness(defaults.harness.provider, defaults.harness.harness);
        }
    }

    // What a pick does to the pending divider.
    private divide(divider: PickEffects["divider"]): void {
        if (divider === `refresh`) {
            this.refreshSwitchNotice();
        } else if (divider === `freeze`) {
            this.pendingSwitchNoticeId = undefined;
        } else if (divider !== undefined) {
            this.noticeMidTurnSwitch(divider.settle);
        }
    }

    // The settle's half: switches made while the turn ran, asked in the order that keeps them to one line.
    private noticeMidTurnSwitch(segmentSwitched: boolean): void {
        const text = midTurnSwitchText(this.switchPoint(), segmentSwitched);
        if (text !== undefined && this.pendingSwitchNoticeId === undefined) {
            this.pendingSwitchNoticeId = this.host.transcript.notice(text);
        }
    }

    // Where the selection stands against what the chat has done, for the divider's words.
    private switchPoint(): SwitchPoint {
        const session = this.host.session.value;
        const provider = this.provider.value;
        const account = this.account.value;
        const model = { id: this.model.value, label: modelLabelFor(provider, this.model.value) };
        return {
            started: this.host.transcript.messages.value.length > 0 || session !== undefined,
            resumes: readsAsContinuing(session, { agent: provider, account, harness: this.harness.value }),
            segment: segmentOf(session, { provider, account }),
            // The picker's own heading for the provider, which is also what the composer's placeholder says ("Ask Codex…"):
            // the account-tab name ("ChatGPT") here made one switch read as three different products.
            providerLabel: providerLabel(provider),
            accountLabel: account === undefined ? undefined : (providerAccounts.value[provider] ?? []).find((entry) => entry.id === account)?.label,
            loopLabel: loopLabel(provider, loopOf(provider, this.harness.value)),
            sentModel: this.state.value.sentModel,
            model: model.id,
            modelLabel: model.label,
            allowance: this.allowanceNote(model),
            // A person's words only: the daemon runs those on the routing they were queued with, where the sandbox's and
            // an agent's own messages take the conversation's current one (turn-admission.ts turnOf).
            waiting: (this.host.queue.value?.items ?? []).filter((item) => item.voice === `person` && item.continues !== true).length,
        };
    }

    // Whose allowance the new model spends, when the plan meters it separately and this sandbox has a reading for it.
    // The at-most mark rides along since a stale reading can only have been spent further; the reset date shows once the pool is spent.
    private allowanceNote(model: { readonly id: string; readonly label: string }): string {
        const usage = usageStatusFor(this.provider.value, this.account.value, model);
        const allowance = modelAllowance(usage, model);
        if (usage === undefined || allowance === undefined) {
            return ``;
        }
        const resetsAt = allowance.percent >= SPENT_UTILIZATION ? allowance.resetsAt : undefined;
        return ` · ${allowance.name} ${formatRemaining(allowance.percent, isStale(usage))}${
            resetsAt === undefined ? `` : `, ${t(`chat.composerSelection.resets`, { when: formatReset(resetsAt) })}`
        }`;
    }

    // The pending divider again, once a read of the transcript has painted its rows: a chat closed and opened again keeps
    // its pick with its tab, but the divider was only ever a row in this window's transcript, so the chat came back on
    // another provider with nothing saying its next message starts a fresh session. Measured only against a session the
    // chat holds: without one every chat on a sessionless provider would read as switched.
    reassertSwitchNotice(): void {
        const noticeId = this.pendingSwitchNoticeId;
        if (noticeId !== undefined && this.host.transcript.messages.value.some((message) => message.id === noticeId)) {
            return;
        }
        this.pendingSwitchNoticeId = undefined;
        if (this.host.session.value !== undefined) {
            this.refreshSwitchNotice();
        }
    }

    // Retract the pending "switched" divider: the change it announced is no longer what the next send does.
    private dropSwitchNotice(): void {
        const noticeId = this.pendingSwitchNoticeId;
        if (noticeId === undefined) {
            return;
        }
        this.host.transcript.write((state) => ({ ...state, messages: state.messages.filter((message) => message.id !== noticeId) }));
        this.pendingSwitchNoticeId = undefined;
    }

    // Upsert/remove the one pending "switched" divider as settings change; a send freezes it at the segment cut.
    // Waits mid-stream: the transcript's tail belongs to the turn being typed into it.
    private refreshSwitchNotice(): void {
        if (this.host.turn.streaming.value) {
            return;
        }
        const text = switchNoticeText(this.switchPoint());
        if (text === undefined) {
            this.dropSwitchNotice();
            return;
        }
        const noticeId = this.pendingSwitchNoticeId;
        if (noticeId !== undefined) {
            this.host.transcript.rewordNotice(noticeId, text);
            return;
        }
        this.pendingSwitchNoticeId = this.host.transcript.notice(text);
    }
}
