import type { AgentProvider, TurnFact } from "@intentic/sandbox-contract";
import { ref, type Ref } from "vue";
import type { PickUp } from "./pickUp";
import { markAccountReauth } from "../accounts/providerAccounts";
import type { SessionRef } from "./turnRequest";
import { bindingWindow, usageStatusFor } from "../session/usageStatus";
import type { TranscriptView } from "../session/transcriptView";
import type { TurnClient } from "../session/turnClient";
import { importOrReload } from "../../../router/staleChunk";

// Maps a turn failure's code to what this window does: whether the user is needed (red line) or merely informed, and
// whether the turn returns on its own. The daemon owns the failure's transcript line and keeps a refused message in the
// conversation's queue, held; recovery state for the auto-resuming codes lives here.

type TurnError = Extract<TurnFact, { kind: "error" }>;

// A provider outage in progress: when the breaker next lets a retry through (epoch seconds), and whether this
// conversation is armed to take it; the tries it has spent ride the pick-up (PickUp.retries).
export interface OutageResume {
    readonly retryAt: number;
    readonly scheduled: boolean;
}

// Renewal probe (1s+25x3s) must outlast the daemon's AUTH_RESUME_DEADLINE_MS (1 minute) re-mint window.
const RENEWAL_PROBE = { delayMs: 1_000, intervalMs: 3_000, tries: 25 } as const;
const OUTAGE_PROBE = { delayMs: 10_000, intervalMs: 15_000, tries: 20 } as const;
// The daemon's held pass opens the fresh session on its next beat (every 5s); 2s+10x3s outlasts several beats.
const FRESH_SESSION_PROBE = { delayMs: 2_000, intervalMs: 3_000, tries: 10 } as const;

// The subset of a conversation a failure can touch or act on.
export interface FailureHost {
    // Where a failure's notice line goes, mirrored once written: it is part of the conversation.
    readonly transcript: Pick<TranscriptView, "messages" | "notice" | "persist">;
    readonly provider: Readonly<Ref<AgentProvider>>;
    readonly account: Readonly<Ref<string | undefined>>;
    // The model this chat is on; a refusal's fallback reset reads off the pool this model spends.
    readonly model: Readonly<Ref<string>>;
    // Dropped when the daemon no longer has the session behind this chat.
    readonly session: Ref<SessionRef | undefined>;
    // The red line: this needs the user.
    readonly error: Ref<string | null>;
    // This turn died mid-work with nothing left to fix; one press continues it (pickUp.ts).
    readonly pickUp: Ref<PickUp | undefined>;
    // The runs: a probe stands down while one is live (the run it was hunting is already here); a restarted run is
    // attached to.
    readonly turn: Pick<TurnClient, "streaming" | "reattach">;
}

export class TurnFailures {
    // The outage this conversation is waiting out; cleared when the next turn starts (resume or user send).
    readonly outageResume = ref<OutageResume | undefined>();

    // Credential renewal wait; cleared on reattach or timeout. Carries `since`, not a reset instant.
    readonly credentialRenewal = ref<{ since: number } | undefined>();

    // A turn that outgrew the model's window, which the daemon re-runs in a fresh session; watched once the stream ends.
    private freshSession = false;

    // Timer for the pending reattach probe; a fresh failure's schedule replaces whatever was armed before.
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly host: FailureHost) {}

    // Routes a turn failure by its code to how it is presented and recovered from.
    apply(error: TurnError): void {
        const { message, code } = error;
        switch (code) {
            case `claude-reauth`:
                // Credential dead, nothing ran: the daemon holds the message in the queue until the account is back.
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
            // Nothing ran, and the daemon holds the message in the queue: an unrecognized command until it is reworded, a
            // turn too big for the model until a bigger one is picked, low memory until the person says go ahead.
            case `unknown-command`:
            case `context-window-too-small`:
            case `sandbox-memory-low`:
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
                this.applyOutageError(error);
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
                            await chat.loadProviderModels(this.host.provider.value);
                        }
                    },
                );
                return;
            case `grok-model-invalid`:
            case `codex-model-invalid`:
                // Daemon rejected the pinned model (after Grok's own mid-turn self-heal fails, or always for Codex);
                // reload the provider's catalog so the picker repoints to what's actually served.
                importOrReload(
                    () => import(`../models/useChat-catalog`),
                    (chat) => chat.loadProviderModels(this.host.provider.value),
                );
                this.host.error.value = message;
                return;
            default:
                this.applyUnhandledError(error);
                return;
        }
    }

    // Failures this window cannot fix itself: the red line; where nothing was processed yet the daemon holds the message.
    // `context-overflow`, `model-unavailable` and `engine-version-floor` get their own handling; the rest fall through.
    private applyUnhandledError(error: TurnError): void {
        const { message, code } = error;
        if (code === `context-overflow`) {
            this.applyOverflowError(error);
            return;
        }
        if (code === `model-unavailable`) {
            // Model exists but isn't available on this plan; the daemon already dropped it from the catalog. Held in the
            // queue for retry (nothing was spent) while the catalog reloads and the picker repoints.
            importOrReload(
                () => import(`../models/useChat-catalog`),
                (chat) => chat.loadProviderModels(this.host.provider.value),
            );
            this.host.error.value = message;
            return;
        }
        if (code === `engine-version-floor`) {
            // Nothing ran (old engine refused): message held in the queue for retry. Error text adds where to install a
            // newer engine, since the daemon's own message can't say that.
            const floor = error.engine?.floor;
            // Where to install is all this adds; that the message is held is the transcript notice's line to say.
            this.host.error.value =
                `${message} Install a newer engine under Sandbox ▸ Environment ▸ Agent engines` +
                `${floor === undefined ? `` : ` (${floor} or newer)`}.`;
            return;
        }
        this.host.error.value = message;
        // Continue is offered only when the code is unknown: for the three named cases above, nothing here would fix
        // the block and pressing it would just re-fail. `held` rides through, so the press re-runs the turn the daemon
        // kept rather than appending a word after it.
        if (code === undefined) {
            this.host.pickUp.value = {
                reason: `stopped`,
                ...(error.nextAt === undefined ? {} : { nextAt: error.nextAt * 1_000 }),
                ...(error.retries === undefined ? {} : { retries: error.retries }),
                ...(error.held === undefined ? {} : { held: error.held }),
            };
        }
    }

    // Lights the reauth badge on the account this turn ran under; both reauth codes mark the same account the
    // same way.
    private markReauth(detail: string): void {
        markAccountReauth(this.host.provider.value, this.host.account.value, detail);
    }

    // A spent allowance is a wait, not a crash: muted, not red, and nothing is resent unless this conversation's
    // answer for the ending says so. `held` means continuing resends the same turn, not a new message.
    private applyLimitError(error: TurnError): void {
        const model = this.host.model.value === `` ? undefined : { id: this.host.model.value };
        const resetsAt = error.resetsAt ?? bindingWindow(usageStatusFor(this.host.provider.value, this.host.account.value, model), model)?.resetsAt;
        this.host.pickUp.value = {
            reason: `limit`,
            // `resetsAt` always comes from the frame, never the store's fallback; `nextAt` is the daemon's own booking.
            ...(resetsAt === undefined ? {} : { readyAt: resetsAt * 1_000 }),
            ...(error.nextAt === undefined ? {} : { nextAt: error.nextAt * 1_000 }),
            ...(error.held === undefined ? {} : { held: error.held }),
        };
    }

    // Provider outage with a resume in flight: muted notice naming when it retries, not the red line, since it
    // isn't the user's fault. No `outage` (attempts spent) falls back to the red line and returns the message.
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
            this.markReauth(error.message);
            return;
        }
        // Wait opens here; armRenewalProbe (armed once this turn's stream ends) is what closes it. What waits in the
        // queue stays there until the renewed turn is done: the daemon never lets it race a recovery.
        this.credentialRenewal.value = { since: Date.now() };
    }

    // A turn that outgrew the model's window: the daemon re-runs it once in a fresh session by itself, holding its queue
    // for that run, and this window watches for it rather than reddening. The re-run overflowing too is red.
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
        this.freshSession = false;
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
        this.host.transcript.persist();
    }
}
