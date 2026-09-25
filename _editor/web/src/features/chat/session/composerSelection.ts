import { capabilitiesOf, clampMode, fastAllowed, type PermissionMode, providerLabel, SPENT_UTILIZATION } from "@intentic/sandbox-contract";
import { computed, shallowRef } from "vue";
import { modelLabelFor, providerModels, providerTabs } from "../accounts/providerCatalog";
import { clampEffort } from "../models/run-settings/effortScale";
import { rememberedModelFor, rememberedProviderFor, rememberPick, turnDefaults } from "../run/turnDefaults";
import { resumes, type TurnSettings } from "../run/turnRequest";
import type { Conversation } from "./conversation";
import { type PickAction, type PickEffects, type PickWorld, reduceSelection, type Selection, UNPICKED } from "./selectionReducer";
import type { TranscriptView } from "./transcriptView";
import type { TurnClient } from "./turnClient";
import { formatReset, formatUtilization, isStale, modelAllowance, usageStatusFor } from "./usageStatus";

// A conversation's selection as the composer binds it: the value `reduceSelection` moves, read one pick at a time, and
// the one "switched" divider a change of it owes the transcript. Which picks a switch retires is the reducer's rule;
// what the divider says is the pure functions below; this class only carries out what a pick asks of the world.

// Where a switch is measured from: what the chat has done so far and what the selection now is.
export interface SwitchPoint {
    // Anything has happened on this chat: a row on screen, or a session held.
    readonly started: boolean;
    // The held session still matches the selection, so the next turn resumes it.
    readonly resumes: boolean;
    // The provider as the picker names it.
    readonly providerLabel: string;
    // The model the last sent turn went out under; undefined before any, or once the segment was cut.
    readonly sentModel: string | undefined;
    readonly model: string;
    readonly modelLabel: string;
    // Whose allowance the model spends, when the plan meters it separately (` · 5h 87% used`), else empty.
    readonly allowance: string;
}

// A provider, account or harness switch retires the session; unconditional about what carries over, since that is the
// daemon's own record, not what this window happens to have painted.
export const segmentSwitchText = (point: SwitchPoint): string | undefined =>
    !point.started || point.resumes
        ? undefined
        : `Switched to ${point.providerLabel}: your next message starts a fresh session with the conversation so far carried over.`;

// A model swap keeps the session and still costs something: it re-reads the whole conversation on a cold cache.
// Nothing sent yet on this segment, or the pick back where the last turn left it, says nothing.
export const modelSwitchText = (point: SwitchPoint): string | undefined =>
    point.sentModel === undefined || point.sentModel === point.model ? undefined : `Switched to ${point.modelLabel}${point.allowance}`;

// The pending divider's words while settings change; undefined retracts it.
export const switchNoticeText = (point: SwitchPoint): string | undefined => segmentSwitchText(point) ?? modelSwitchText(point);

// The divider a turn's settle owes for switches made while it ran; a segment switch counts only when one was made,
// since a sessionless provider would otherwise always look switched.
export const midTurnSwitchText = (point: SwitchPoint, switchedMidTurn: boolean): string | undefined =>
    (switchedMidTurn ? segmentSwitchText(point) : undefined) ?? modelSwitchText(point);

// What a selection reads and writes of the conversation around it.
type SelectionHost = Pick<Conversation, "session" | "activeModel" | "contextUsage" | "fastMode" | "box" | "peek"> & {
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
    readonly auto = computed(() => this.state.value.auto);
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
    // one-turn Auto mark: it belongs to the turn the judge decided, and the next one on the same model is the user's.
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
            defaults: () => ({
                provider: rememberedProviderFor(),
                picked: turnDefaults.provider.value,
                harness: turnDefaults.harness.value,
                effort: turnDefaults.effort.value,
                thinking: turnDefaults.thinking.value,
                auto: turnDefaults.auto.value,
            }),
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
            turnDefaults.harness.value = defaults.harness;
        }
    }

    // What a pick does to the pending divider.
    private divide(divider: PickEffects["divider"]): void {
        if (divider === `refresh`) {
            this.refreshSwitchNotice();
        } else if (divider === `drop`) {
            this.dropSwitchNotice();
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
        const model = { id: this.model.value, label: modelLabelFor(this.provider.value, this.model.value) };
        return {
            started: this.host.transcript.messages.value.length > 0 || session !== undefined,
            resumes: resumes(session, { agent: this.provider.value, account: this.account.value, harness: this.harness.value }),
            // ACP providers have no tab entry; falls back to the capability name or the raw provider id.
            providerLabel: providerTabs.find((tab) => tab.value === this.provider.value)?.label ?? providerLabel(this.provider.value),
            sentModel: this.state.value.sentModel,
            model: model.id,
            modelLabel: model.label,
            allowance: this.allowanceNote(model),
        };
    }

    // Whose allowance the new model spends, when the plan meters it separately and this sandbox has a reading for it.
    // The floor mark rides along since a reading can only have climbed; the reset date shows once the pool is spent.
    private allowanceNote(model: { readonly id: string; readonly label: string }): string {
        const usage = usageStatusFor(this.provider.value, this.account.value, model);
        const allowance = modelAllowance(usage, model);
        if (usage === undefined || allowance === undefined) {
            return ``;
        }
        const resetsAt = allowance.percent >= SPENT_UTILIZATION ? allowance.resetsAt : undefined;
        return ` · ${allowance.name} ${formatUtilization(allowance.percent, isStale(usage))} used${
            resetsAt === undefined ? `` : `, resets ${formatReset(resetsAt)}`
        }`;
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
