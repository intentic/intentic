import type { AgentProvider, TurnFact } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { ref } from "vue";
import { cooledPickUp, type PickUp, warmedPickUp } from "./pickUp";
import { bindingWindow, usageStatusFor } from "../session/usageStatus";
import type { ComposerSelection } from "../session/composerSelection";
import type { Conversation } from "../session/conversation";
import type { TranscriptView } from "../session/transcriptView";
import type { TurnClient } from "../session/turnClient";
import { importOrReload } from "../../../lib/staleChunk";
import { markNeedsReauth, providerAccounts } from "../accounts/providerAccounts";

// Maps a turn failure's code to what this window does: whether the user is needed (the error line) or merely informed, and
// whether the turn returns on its own. The daemon owns the failure's transcript line and keeps a refused message in the
// conversation's queue, held; recovery state for the auto-resuming codes lives here.

type TurnError = Extract<TurnFact, { kind: "error" }>;

// A provider outage in progress: when the breaker next lets a retry through (epoch seconds), and whether this
// conversation is armed to take it; the tries it has spent ride the pick-up (PickUp.retries).
export interface OutageResume {
    readonly retryAt: number;
    readonly scheduled: boolean;
}

// The daemon refused the pinned model (not served, or not on this plan); the reloaded catalog repoints the picker.
const MODEL_REFUSED: ReadonlySet<TurnError["code"]> = new Set([`grok-model-invalid`, `codex-model-invalid`, `model-unavailable`]);

// Renewal probe (1s+25x3s) must outlast the daemon's AUTH_RESUME_DEADLINE_MS (1 minute) re-mint window.
const RENEWAL_PROBE = { delayMs: 1_000, intervalMs: 3_000, tries: 25 } as const;
const OUTAGE_PROBE = { delayMs: 10_000, intervalMs: 15_000, tries: 20 } as const;
// The daemon's held pass opens the fresh session on its next beat (every 5s); 2s+10x3s outlasts several beats.
const FRESH_SESSION_PROBE = { delayMs: 2_000, intervalMs: 3_000, tries: 10 } as const;

// The subset of a conversation a failure can touch or act on.
export type FailureHost = Pick<Conversation, "session" | "error" | "pickUp"> & {
    readonly transcript: Pick<TranscriptView, "messages" | "notice" | "persist">;
    readonly selection: Pick<ComposerSelection, "provider" | "account" | "model">;
    readonly turn: Pick<TurnClient, "streaming" | "reattach">;
};

export class TurnFailures {
    // The outage this conversation is waiting out; cleared when the next turn starts (resume or user send).
    readonly outageResume = ref<OutageResume | undefined>();

    // Credential renewal wait; cleared on reattach or timeout. Carries `since`, not a reset instant.
    readonly credentialRenewal = ref<{ since: number } | undefined>();

    // The words of a failure that took back what an earlier one in the same turn promised (to come back by itself): the
    // sandbox keeps one hold per turn, so the later failure is the one it acts on. Its roster keeps reading `resuming`
    // regardless, so the board draws the stop this chat shows from this (TabFacts.resumeWithdrawn). Cleared as a turn starts.
    readonly resumeWithdrawn = ref<string | undefined>();

    // Whether this turn's last failure said it comes back by itself, as the sandbox reads one (comingBackNow): a re-mint,
    // a retry or a re-run is booked, a spent allowance's reset is not.
    private promised = false;

    // Whether this turn failed at all; a turn that ended on none proves the account it ran on still signs in.
    private failed = false;

    // A turn that outgrew the model's window, which the daemon re-runs in a fresh session; watched once the stream ends.
    private freshSession = false;

    // Timer for the pending reattach probe; a fresh failure's schedule replaces whatever was armed before.
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly host: FailureHost) {}

    // Routes a turn failure by its code to how it is presented and recovered from.
    apply(error: TurnError): void {
        const { message, code } = error;
        const comingBack = error.autoResume === `scheduled` && code !== `rate_limit`;
        if (this.promised && !comingBack) {
            this.withdrawResume(message);
        }
        this.promised = comingBack;
        this.failed = true;
        switch (code) {
            case `claude-reauth`:
                // Credential dead, nothing ran: the daemon holds the message in the queue until the account is back.
                // No error line: the composer already shows a reauth banner with the one-click fix.
                this.markReauth(error, message);
                return;
            case `codex-reauth`:
                // Same badge as claude-reauth, but also the error line: no held message here to replay instead.
                this.markReauth(error, message);
                this.host.error.value = message;
                return;
            case `claude-token-refused`:
                this.applyAuthRefusedError(error);
                return;
            // Nothing ran, and the daemon holds the message in the queue: an unrecognized command until it is reworded, a
            // turn too big for the model (or a model that can only write one-shot jobs, or one the privacy shield cannot
            // cover, or one whose own rules hold personal data) until another is picked or it is let through, low memory
            // until the person says go ahead. The privacy strip says why above the composer.
            case `unknown-command`:
            case `context-window-too-small`:
            case `model-helper-only`:
            case `privacy-unshielded`:
            case `privacy-instructions`:
            case `sandbox-memory-low`:
                return;
            case `session-not-found`:
                // Session vanished mid-turn: drop the dead id so the next send starts fresh. No error line.
                this.host.session.value = undefined;
                return;
            case `codex-advisory`:
                // Codex warned but finished the turn; the daemon's muted line already covers it.
                return;
            case `rate_limit`:
                this.applyLimitError(error);
                return;
            case `provider-outage`:
                this.applyOutageError(error);
                return;
            case `safeguard-flagged`:
                this.applyFlaggedError(error);
                return;
            case `trial-unavailable`:
            case `trial-model-unavailable`:
            case `trial-exhausted`:
                // Message undelivered and refunded; held in the queue for explicit retry, not the outage auto-resume loop.
                importOrReload(
                    () => import(`../models/useChat-catalog`),
                    async (chat) => {
                        await chat.loadTrialStatus();
                        if (code === `trial-model-unavailable`) {
                            await chat.loadProviderModels(this.host.selection.provider.value);
                        }
                    },
                );
                return;
            default:
                this.applyUnhandledError(error);
                return;
        }
    }

    // Failures this window cannot fix itself: the error line; where nothing was processed yet the daemon holds the message.
    private applyUnhandledError(error: TurnError): void {
        const { message, code } = error;
        if (code === `context-overflow`) {
            this.applyOverflowError(error);
            return;
        }
        if (MODEL_REFUSED.has(code)) {
            importOrReload(
                () => import(`../models/useChat-catalog`),
                (chat) => chat.loadProviderModels(this.host.selection.provider.value),
            );
            this.host.error.value = message;
            return;
        }
        if (code === `engine-version-floor`) {
            // Nothing ran (old engine refused): message held in the queue for retry. Error text adds where to install a
            // newer engine, since the daemon's own message can't say that.
            const floor = error.engine?.floor;
            // Where to install is all this adds; that the message is held is the transcript notice's line to say.
            this.host.error.value = `${message} ${
                floor === undefined ? t(`chat.turnFailures.installNewerEngine`) : t(`chat.turnFailures.installNewerEngineFloor`, { floor })
            }`;
            return;
        }
        if (code === `acp-auth-required`) {
            // The agent refuses every turn until it is signed in, and only its own login command does that: say where.
            this.host.error.value = `${message} ${t(`chat.turnFailures.signAgentIn`)}`;
            return;
        }
        this.host.error.value = message;
        // Continue only for an unknown code, since a named one re-fails; `held` makes the press re-run the kept turn.
        if (code === undefined) {
            this.host.pickUp.value = {
                reason: `stopped`,
                ...(error.nextAt === undefined ? {} : { nextAt: error.nextAt * 1_000 }),
                ...(error.retries === undefined ? {} : { retries: error.retries }),
                ...(error.held === undefined ? {} : { held: error.held }),
            };
        }
    }

    // Lights the reauth badge at once, on the account the frame names as having served the turn: the daemon's word, never
    // a guess. A frame naming none (a turn on no stored account) lights nothing; the account list says it on its next read.
    private markReauth(error: Pick<TurnError, "account">, detail: string): void {
        if (error.account !== undefined) {
            markNeedsReauth(this.host.selection.provider.value, error.account, detail);
        }
    }

    // A spent allowance is a wait, not a crash: muted, not the error line, and nothing is resent unless this conversation's
    // answer for the ending says so. `held` means continuing resends the same turn, not a new message.
    private applyLimitError(error: TurnError): void {
        const model = this.host.selection.model.value === `` ? undefined : { id: this.host.selection.model.value };
        // The account the frame names served the turn; one naming none has no reading of its own to guess a reset from.
        const resetsAt = error.resetsAt ?? bindingWindow(usageStatusFor(this.host.selection.provider.value, error.account, model), model)?.resetsAt;
        // Rests the press a minute when nothing ran (pickUp.cooledPickUp), then hands it back.
        const pickUp = cooledPickUp({
            reason: `limit`,
            // `resetsAt` always comes from the frame, never the store's fallback; `nextAt` is the daemon's own booking.
            ...(resetsAt === undefined ? {} : { readyAt: resetsAt * 1_000 }),
            ...(error.nextAt === undefined ? {} : { nextAt: error.nextAt * 1_000 }),
            ...(error.held === undefined ? {} : { held: error.held }),
        });
        this.host.pickUp.value = pickUp;
        const until = pickUp.coolUntil;
        if (until !== undefined) {
            setTimeout(() => {
                const shown = this.host.pickUp.value;
                if (shown?.coolUntil === until) {
                    this.host.pickUp.value = warmedPickUp(shown);
                }
            }, until - Date.now());
        }
    }

    // The provider's safety classifier stopped the turn: the daemon holds it, and the card asks the person each time
    // whether to send it again on this model or go on with another. The transcript's own line carries the provider's
    // words, so no error line repeats them above a card that already offers the way on.
    private applyFlaggedError(error: TurnError): void {
        this.host.error.value = null;
        this.host.pickUp.value = error.held === undefined ? { reason: `flagged` } : { reason: `flagged`, held: error.held };
    }

    // Provider outage with a resume in flight: muted notice naming when it retries, not the error line, since it
    // isn't the user's fault. No `outage` (attempts spent) falls back to the error line and returns the message.
    private applyOutageError(error: TurnError): void {
        const { message, outage } = error;
        if (outage === undefined) {
            this.host.error.value = message;
            return;
        }
        const scheduled = error.autoResume === `scheduled`;
        this.outageResume.value = { retryAt: outage.retryAt, scheduled };
        // Same pickUp shape every failure leaves, so the card is one card; the press stays live whatever is booked.
        this.host.pickUp.value = {
            reason: `outage`,
            ...(error.nextAt === undefined ? {} : { nextAt: error.nextAt * 1_000 }),
            ...(error.retries === undefined ? {} : { retries: error.retries }),
        };
        if (scheduled) {
            this.scheduleReattach(outage.retryAt * 1000, OUTAGE_PROBE);
        }
    }

    // Token refused mid-turn, almost always the daemon's own rotation: re-mint and resume happen automatically,
    // watched via a probe rather than surfaced as broken. No armed renewal means the credential is dead: reconnect.
    private applyAuthRefusedError(error: TurnError): void {
        if (error.autoResume !== `scheduled`) {
            this.markReauth(error, error.message);
            return;
        }
        // Wait opens here; armRenewalProbe (armed once this turn's stream ends) is what closes it. What waits in the
        // queue stays there until the renewed turn is done: the daemon never lets it race a recovery.
        this.credentialRenewal.value = { since: Date.now() };
    }

    // A turn that outgrew the model's window: the daemon re-runs it once in a fresh session by itself, holding its queue
    // for that run, and this window watches for it rather than raising the error line. A re-run that overflows too raises it.
    private applyOverflowError(error: TurnError): void {
        if (error.autoResume !== `scheduled`) {
            this.host.error.value = error.message;
            return;
        }
        this.host.error.value = null;
        this.host.pickUp.value = undefined;
        this.freshSession = true;
    }

    // Armed only once this turn's stream ends, not from this failure frame directly: firing mid-stream would see
    // the conversation still open and wrongly conclude the resumed run is already here. Covers both runs the daemon
    // renews by itself: a re-minted credential's, and a fresh session's after the window overflowed.
    armRenewalProbe(): void {
        if (this.freshSession) {
            this.freshSession = false;
            this.scheduleReattach(Date.now(), FRESH_SESSION_PROBE);
            return;
        }
        if (this.credentialRenewal.value === undefined) {
            return;
        }
        this.scheduleReattach(Date.now(), RENEWAL_PROBE, () => this.giveUpOnRenewal());
    }

    // The outage is the one ending with a second party already retrying it, so this window has to watch for the run
    // the daemon brings back — or a resumed turn streams into nothing. Everything else about the answer (what is
    // armed, what the card says, what the countdown reads) comes from the policy itself; there is nothing to mirror
    // here, and no notice to write, because a toggle's state belongs on the toggle.
    watchOutage(on: boolean): void {
        const pending = this.outageResume.value;
        if (pending === undefined) {
            return;
        }
        this.outageResume.value = { ...pending, scheduled: on };
        if (!on) {
            this.cancelProbe();
            return;
        }
        this.scheduleReattach(pending.retryAt * 1000, OUTAGE_PROBE);
    }

    // Called when a turn starts on this conversation: every wait is over, by resume or by the user's own send.
    clear(): void {
        this.outageResume.value = undefined;
        this.credentialRenewal.value = undefined;
        this.resumeWithdrawn.value = undefined;
        this.promised = false;
        this.failed = false;
        this.freshSession = false;
    }

    // A later failure replaced the hold an earlier one armed, so nothing comes back by itself: no renewal spinner, no
    // outage countdown, and no probe that would give up minutes later and blame the credential. The transcript's row
    // says so itself (transcript-fold's withdrawRenewal); the stop's own pick-up is the way on.
    private withdrawResume(message: string): void {
        this.credentialRenewal.value = undefined;
        this.outageResume.value = undefined;
        this.freshSession = false;
        this.cancelProbe();
        this.resumeWithdrawn.value = message;
    }

    // Called as a turn's stream ends. One that ended on no failure ran on an account that signs in, so a reconnect this
    // provider's accounts were marked for is asked of the sandbox again rather than left standing until some later read:
    // the list's answer, not this window's, is what lights or clears the banner.
    settled(): void {
        const provider = this.host.selection.provider.value;
        if (this.failed || !(providerAccounts.value[provider] ?? []).some((account) => account.needsReauth === true)) {
            return;
        }
        rereadAccounts(provider);
    }

    // Probes for the daemon's restarted run starting at `dueAt` + the profile's delay, then on its interval until
    // it attaches or attempts run out. `exhausted` fires if the whole budget passes with nothing found.
    private scheduleReattach(dueAt: number, profile: { delayMs: number; intervalMs: number; tries: number }, exhausted?: () => void): void {
        clearTimeout(this.timer);
        let attempts = 0;
        const probe = (): void => {
            if (this.host.turn.streaming.value) {
                return;
            }
            attempts += 1;
            void this.host.turn.reattach().then((attached) => {
                if (attached || this.host.turn.streaming.value) {
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

    // How the last turn ended, as the daemon has it (AgentTranscriptSchema.ending), for a tab that never watched it
    // happen; arms the same pick-up a watching window would, down to the countdown and what the press does. Refused
    // when the record shows no ending, a turn is already live, a pick-up is already held, or the transcript is empty.
    adoptEnding(ending: PickUp | undefined): void {
        const { turn, pickUp, transcript } = this.host;
        if (ending === undefined || turn.streaming.value || pickUp.value !== undefined || transcript.messages.value.length === 0) {
            return;
        }
        pickUp.value = ending;
    }

    // Called on a send or on losing the tab/sandbox; the daemon's own resume still fires independently and
    // replays on reopen.
    cancelProbe(): void {
        clearTimeout(this.timer);
    }

    // Probe budget exhausted with nothing to attach to: the spinner stops and the turn is said to have stopped. Whether the
    // account needs reconnecting is the sandbox's to say, never this window's guess from a timeout (one such guess sat on
    // every chat for two hours while the account kept answering), so its account list is read again instead.
    private giveUpOnRenewal(): void {
        if (this.credentialRenewal.value === undefined) {
            return;
        }
        this.credentialRenewal.value = undefined;
        rereadAccounts(this.host.selection.provider.value);
        this.host.transcript.notice(t(`chat.turnFailures.renewalDidNotResume`));
        this.host.transcript.persist();
    }
}

// The sandbox's own account list for a provider, which is what marks an account for reconnecting or clears it. Late
// imported, as the catalog is above: the accounts module reaches back into the conversation tabs.
const rereadAccounts = (provider: AgentProvider): void =>
    importOrReload(
        () => import(`../accounts/useChat-accounts`),
        (accounts) =>
            accounts.refreshAccounts(provider).catch((cause: unknown) => {
                console.warn("Could not refresh provider accounts", cause);
                return undefined;
            }),
    );
