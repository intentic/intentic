import type { AgentProvider, TurnFact } from "@intentic/sandbox-contract";
import { ref, type Ref } from "vue";
import type { PickUp } from "./pickUp";
import { markAccountReauth } from "../accounts/providerAccounts";
import type { TranscriptClock } from "../transcript/transcriptClock";
import type { SessionRef } from "./turnRequest";
import type { TurnContext } from "./turnStream";
import { bindingWindow, formatWait, usageStatusFor } from "../session/usageStatus";

// Maps a turn failure's code to what this window does: whether the user is needed (red line) or merely informed,
// whether the message is held for retry, and whether the turn returns on its own. The daemon owns the failure's
// transcript line; recovery state for the two auto-resuming codes lives here.

type TurnError = Extract<TurnFact, { kind: "error" }>;

// True when the daemon will resend this turn itself: a booked move fires now, a scheduled reset fires at
// `resetsAt`. Undefined if nothing is armed or the provider gave no reset instant.
const limitAutomatic = (error: TurnError, now: number = Date.now()): { readonly at: number } | undefined => {
    if (error.autoResume !== `scheduled`) {
        return undefined;
    }
    if (error.held?.moving !== undefined) {
        return { at: now };
    }
    return error.resetsAt === undefined ? undefined : { at: error.resetsAt * 1_000 };
};

// A provider outage in progress: next retry time, attempts used and allowed, and whether it is armed to fire
// automatically. Drives the composer's outage banner.
export interface OutageResume {
    readonly retryAt: number;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly scheduled: boolean;
}

// Renewal probe (1s+25x3s) must outlast the daemon's AUTH_RESUME_DEADLINE_MS (1 minute) re-mint window.
const RENEWAL_PROBE = { delayMs: 1_000, intervalMs: 3_000, tries: 25 } as const;
const OUTAGE_PROBE = { delayMs: 10_000, intervalMs: 15_000, tries: 20 } as const;

// The subset of a conversation a failure can touch or act on.
export interface FailureHost {
    // Where a failure's notice line goes, and where a refused turn's bubble is pulled back out to.
    readonly transcript: TranscriptClock;
    readonly provider: Ref<AgentProvider>;
    readonly account: Ref<string | undefined>;
    // The model this chat is on; a refusal's fallback reset reads off the pool this model spends.
    readonly model: Ref<string>;
    // Dropped when the daemon no longer has the session behind this chat.
    readonly session: Ref<SessionRef | undefined>;
    // The red line: this needs the user.
    readonly error: Ref<string | null>;
    // This turn died mid-work with nothing left to fix; one press continues it (pickUp.ts).
    readonly pickUp: Ref<PickUp | undefined>;
    // A probe stands down while a turn is live, the run it was hunting is already here.
    readonly streaming: Ref<boolean>;
    // Pulls the user's undelivered message out of the transcript, back into the queue for their next send.
    requeue(userMessageId: number): void;
    // Holds the queue in place: a message behind a killed turn must not race the daemon's resume to POST /agent
    // and lose.
    hold(): void;
    // Attach to a run the daemon restarted; whether one was found.
    reattach(): Promise<boolean>;
    // Mirror the transcript to the local cache, a notice this raised is part of the conversation.
    persist(): void;
}

export class TurnFailures {
    // The outage this conversation is waiting out; cleared when the next turn starts (resume or user send).
    readonly outageResume = ref<OutageResume | undefined>();

    // Credential renewal wait; cleared on reattach or timeout. Carries `since`, not a reset instant.
    readonly credentialRenewal = ref<{ since: number } | undefined>();

    // Timer for the pending reattach probe; a fresh failure's schedule replaces whatever was armed before.
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly host: FailureHost) {}

    // Routes a turn failure by its code to how it is presented and recovered from.
    apply(error: TurnError, turn: TurnContext): void {
        const { message, code } = error;
        switch (code) {
            case `claude-reauth`:
                // Credential dead, nothing ran: message isn't in the conversation; return it to the queue.
                this.host.requeue(turn.userMessageId);
                // No red line: the composer already shows a reauth banner with the one-click fix.
                this.markReauth(message);
                return;
            case `codex-reauth`:
                // Same badge as claude-reauth, but also red line: no held message here to replay instead.
                this.markReauth(message);
                this.host.error.value = message;
                return;
            case `claude-token-refused`:
                this.applyAuthRefusedError(error);
                return;
            case `unknown-command`:
                // Unrecognized command, nothing ran: message goes back to the held queue, not flushed.
                this.host.requeue(turn.userMessageId);
                return;
            case `context-window-too-small`:
                // Model can't hold this turn: message held until a bigger model is picked.
                this.host.requeue(turn.userMessageId);
                return;
            case `sandbox-memory-low`:
                // Sandbox out of memory; not auto-resent, since retrying now would just refuse again.
                this.host.requeue(turn.userMessageId);
                return;
            case `session-not-found`:
                // Session vanished mid-turn: drop the dead id so the next send starts fresh. No red line.
                this.host.session.value = undefined;
                return;
            case `codex-advisory`:
                // Codex warned but finished the turn; the daemon's muted line already covers it.
                return;
            case `rate_limit`:
                this.applyLimitError(error);
                return;
            case `provider-outage`:
                this.applyOutageError(error, turn);
                return;
            case `trial-unavailable`:
            case `trial-model-unavailable`:
            case `trial-exhausted`:
                // Message undelivered and refunded; held for explicit retry, not the outage auto-resume loop.
                this.host.requeue(turn.userMessageId);
                void import(`../models/useChat-catalog`).then(async (chat) => {
                    await chat.loadTrialStatus();
                    if (code === `trial-model-unavailable`) {
                        await chat.loadProviderModels(this.host.provider.value);
                    }
                });
                return;
            case `grok-model-invalid`:
            case `codex-model-invalid`:
                // Daemon rejected the pinned model (after Grok's own mid-turn self-heal fails, or always for Codex);
                // reload the provider's catalog so the picker repoints to what's actually served.
                void import(`../models/useChat-catalog`).then((chat) => chat.loadProviderModels(this.host.provider.value));
                this.host.error.value = message;
                return;
            default:
                this.applyUnhandledError(error, turn);
                return;
        }
    }

    // Failures with no in-window recovery: the red line, plus a requeue where nothing was processed yet.
    // `model-unavailable` and `engine-version-floor` get their own handling below; the rest fall straight through.
    private applyUnhandledError(error: TurnError, turn: TurnContext): void {
        const { message, code } = error;
        if (code === `model-unavailable`) {
            // Model exists but isn't available on this plan; the daemon already dropped it from the catalog. Held for
            // retry (nothing was spent) while the catalog reloads and the picker repoints.
            void import(`../models/useChat-catalog`).then((chat) => chat.loadProviderModels(this.host.provider.value));
            this.host.requeue(turn.userMessageId);
            this.host.error.value = message;
            return;
        }
        if (code === `engine-version-floor`) {
            // Nothing ran (old engine refused): message held for retry. Error text adds where to install a newer
            // engine, since the daemon's own message can't say that.
            this.host.requeue(turn.userMessageId);
            const floor = error.engine?.floor;
            this.host.error.value =
                `${message} Install a newer engine under Sandbox ▸ Environment ▸ Agent engines` +
                `${floor === undefined ? `` : ` (${floor} or newer)`}. Your message is held below.`;
            return;
        }
        this.host.error.value = message;
        // Continue is offered only when the code is unknown: for the three named cases above, nothing here would fix
        // the block and pressing it would just re-fail.
        if (code === undefined) {
            this.host.pickUp.value = { reason: `stopped` };
        }
    }

    // Lights the reauth badge on the account this turn ran under; both reauth codes mark the same account the
    // same way.
    private markReauth(detail: string): void {
        markAccountReauth(this.host.provider.value, this.host.account.value, detail);
    }

    // A spent allowance is a wait, not a crash: muted, not red, and not auto-resent unless `resumeAfterLimit` is
    // on. `held` means continuing resends the same turn, not a new message.
    private applyLimitError(error: TurnError): void {
        const model = this.host.model.value === `` ? undefined : { id: this.host.model.value };
        const resetsAt = error.resetsAt ?? bindingWindow(usageStatusFor(this.host.provider.value, this.host.account.value, model), model)?.resetsAt;
        // `automatic` mirrors the outage case, so local auto-continue defers to what the daemon already armed.
        // `resetsAt` always comes from the frame, never the store's fallback.
        const automatic = limitAutomatic(error);
        this.host.pickUp.value = {
            reason: `limit`,
            ...(resetsAt === undefined ? {} : { readyAt: resetsAt * 1_000 }),
            ...(error.held === undefined ? {} : { held: error.held }),
            ...(automatic === undefined ? {} : { automatic }),
        };
    }

    // Provider outage with a resume in flight: muted notice naming when it retries, not the red line, since it
    // isn't the user's fault. No `outage` (attempts spent) falls back to the red line and returns the message.
    private applyOutageError(error: TurnError, turn: TurnContext): void {
        const { message, outage } = error;
        if (outage === undefined) {
            this.host.requeue(turn.userMessageId);
            this.host.error.value = message;
            return;
        }
        const scheduled = error.autoResume === `scheduled`;
        this.outageResume.value = { ...outage, scheduled };
        // Same pickUp shape every failure leaves, so the strip is one strip. Scheduled: automatic mark tells local
        // auto-continue to stand down; the manual press stays live regardless.
        this.host.pickUp.value = { reason: `outage`, ...(scheduled ? { automatic: { at: outage.retryAt * 1_000 } } : {}) };
        if (scheduled) {
            this.scheduleReattach(outage.retryAt * 1000, OUTAGE_PROBE);
        }
    }

    // Token refused mid-turn, almost always the daemon's own rotation: re-mint and resume happen automatically,
    // watched via a probe rather than surfaced as broken. No armed renewal means the credential is dead: reconnect.
    private applyAuthRefusedError(error: TurnError): void {
        if (error.autoResume !== `scheduled`) {
            this.markReauth(error.message);
            return;
        }
        this.host.hold();
        // Wait opens here; armRenewalProbe (armed once this turn's stream ends) is what closes it.
        this.credentialRenewal.value = { since: Date.now() };
    }

    // Armed only once this turn's stream ends, not from this failure frame directly: firing mid-stream would see
    // the conversation still open and wrongly conclude the resumed run is already here.
    armRenewalProbe(): void {
        if (this.credentialRenewal.value === undefined) {
            return;
        }
        this.scheduleReattach(Date.now(), RENEWAL_PROBE, () => this.giveUpOnRenewal());
    }

    // The daemon already holds this turn regardless of posture; the press only has to reflect that state locally.
    // Notice names the scope ("this chat") since the standing default lives in Sandbox ▸ Agent.
    armOutageResume(): void {
        const pending = this.outageResume.value;
        if (pending === undefined) {
            return;
        }
        this.outageResume.value = { ...pending, scheduled: true };
        this.host.pickUp.value = { reason: `outage`, automatic: { at: pending.retryAt * 1_000 } };
        this.host.transcript.notice(
            `This chat picks itself back up in ${formatWait(pending.retryAt)} and keeps doing so through provider outages. Only this chat: Sandbox ▸ Agent sets the default for the rest.`,
        );
        this.scheduleReattach(pending.retryAt * 1000, OUTAGE_PROBE);
        this.host.persist();
    }

    // Mirror of armOutageResume for the limit wait: the daemon already holds the turn, so `automatic` only marks
    // it locally. Hidden entirely when there's no `readyAt`, since there's no appointment to arm.
    armLimitResume(): void {
        const pending = this.host.pickUp.value;
        if (pending?.reason !== `limit` || pending.readyAt === undefined) {
            return;
        }
        this.host.pickUp.value = { ...pending, automatic: { at: pending.readyAt } };
        this.host.transcript.notice(
            `This chat sends the turn again by itself once the allowance comes back. Only this chat: Sandbox ▸ Agent sets the default for the rest.`,
        );
        this.host.persist();
    }

    // Clears only the appointment, never the turn: the daemon still holds it, so the press and countdown stay
    // available after this.
    disarmLimitResume(): void {
        const pending = this.host.pickUp.value;
        if (pending?.reason !== `limit`) {
            return;
        }
        const { automatic: _stopped, ...held } = pending;
        this.host.pickUp.value = held;
        this.host.transcript.notice(`Stopped: nothing sends this turn for you. It is still here to send by hand whenever you like.`);
        this.host.persist();
    }

    // Reverts the banner to an offer, not a cancellation: the daemon still holds the turn for the outage window
    // regardless. Also stands the reattach probe down, since nothing is coming to look for.
    disarmOutageResume(): void {
        const pending = this.outageResume.value;
        if (pending === undefined) {
            return;
        }
        this.cancelProbe();
        this.outageResume.value = { ...pending, scheduled: false };
        // Turn is still stranded and pickable; only the automatic mark and countdown go.
        this.host.pickUp.value = { reason: `outage` };
        this.host.transcript.notice(`Stopped: this chat no longer picks itself back up. The turn is still here to resume by hand.`);
        this.host.persist();
    }

    // Called when a turn starts on this conversation: both waits are over, by resume or by the user's own send.
    clear(): void {
        this.outageResume.value = undefined;
        this.credentialRenewal.value = undefined;
    }

    // Probes for the daemon's restarted run starting at `dueAt` + the profile's delay, then on its interval until
    // it attaches or attempts run out. `exhausted` fires if the whole budget passes with nothing found.
    private scheduleReattach(dueAt: number, profile: { delayMs: number; intervalMs: number; tries: number }, exhausted?: () => void): void {
        clearTimeout(this.timer);
        let attempts = 0;
        const probe = (): void => {
            if (this.host.streaming.value) {
                return;
            }
            attempts += 1;
            void this.host.reattach().then((attached) => {
                if (attached || this.host.streaming.value) {
                    return;
                }
                if (attempts < profile.tries) {
                    this.timer = setTimeout(probe, profile.intervalMs);
                    return;
                }
                exhausted?.();
            });
        };
        this.timer = setTimeout(probe, Math.max(0, dueAt + profile.delayMs - Date.now()));
    }

    // Called on a send or on losing the tab/sandbox; the daemon's own resume still fires independently and
    // replays on reopen.
    cancelProbe(): void {
        clearTimeout(this.timer);
    }

    // Probe budget exhausted with nothing to attach to: the re-mint failed for good, so this stops the spinner
    // and asks for a reconnect.
    private giveUpOnRenewal(): void {
        if (this.credentialRenewal.value === undefined) {
            return;
        }
        this.credentialRenewal.value = undefined;
        const detail = `Claude sign-in could not be renewed: reconnect the account.`;
        this.markReauth(detail);
        this.host.transcript.notice(`${detail} This turn stopped where it was; sending again picks the conversation back up.`);
        this.host.persist();
    }
}
