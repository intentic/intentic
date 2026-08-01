import type { AgentProvider } from "@intentic/sandbox-contract";
import { ref, type Ref } from "vue";
import { markAccountReauth } from "./providerAccounts";
import type { TranscriptClock } from "./transcriptClock";
import type { SessionRef } from "./turnRequest";
import type { TurnEffect } from "./turnReducer";
import type { TurnContext } from "./turnStream";
import { bindingWindow, formatReset, formatWait, usageStatusFor } from "./usageStatus";

/* WHAT A FAILED TURN DOES TO THE CONVERSATION — one place, because the answer is a product decision rather than
 * a transcript rule and the codes only differ in that decision. Three things vary and nothing else does: whether
 * the user is NEEDED (the red error line) or merely informed (a muted notice), whether the words they typed
 * survived (a turn refused before it ran produced nothing, so the bubble comes back out and the queue holds it),
 * and whether the turn is COMING BACK on its own.
 *
 * Split out of the reducer because most of these codes need state it has no business reaching for — the
 * account's usage windows, the provider's account list — to phrase themselves at all.
 *
 * The two codes that ARE coming back own state of their own here (the outage's countdown, the credential
 * renewal's spinner) plus the probe that hunts the resumed run down, which is why the recovery lives beside the
 * failure that armed it rather than in the conversation. */

type TurnError = Extract<TurnEffect, { kind: "error" }>;

/* A provider outage the daemon is working through, as this window sees it: when the next attempt is due, how
 * many are left, and whether it is armed or waiting on the setting. Drives the composer's outage banner — the
 * one place that can honestly answer "is anything still happening?", which is the only question a user has
 * during an outage. */
export interface OutageResume {
    readonly retryAt: number;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly scheduled: boolean;
}

/* HOW THIS WINDOW FINDS A TURN THE DAEMON RESTARTED. The daemon owns every automatic resume (turn-resume.ts);
 * what the client owns is RENDERING it — attach streams are pull, and an open tab re-probes only on reachability
 * flips, so a resumed run plays to nobody unless a local probe goes looking for it. That is the whole reason a
 * chat could sit dead on "the credential is being renewed" while the agent it describes was working away on the
 * board: the notice was printed and nothing was ever armed to catch what it promised.
 *
 * The two conditions differ only in how long the wait is worth. A CREDENTIAL RENEWAL is due within one scheduler
 * pass (5s), so it probes fast and gives up inside a minute — past that the re-mint failed, and the honest answer
 * is "reconnect the account" rather than a spinner. An OUTAGE resume is due on a backoff that grows to twenty
 * minutes, so it probes slowly and keeps looking for the best part of an hour. Both give up quietly: the resumed
 * run's transcript replays on the next hydrate either way. */
const RENEWAL_PROBE = { delayMs: 1_000, intervalMs: 3_000, tries: 15 } as const;
const OUTAGE_PROBE = { delayMs: 10_000, intervalMs: 15_000, tries: 20 } as const;

/* The conversation, as much of it as a failure may touch. Written out rather than taking the Conversation whole
 * because it is the useful half of the split: everything a failure can reach is on this list. */
export interface FailureHost {
    // Where a failure's own words go — the muted notice line, and the bubble a refused turn is taken back out of.
    readonly transcript: TranscriptClock;
    readonly provider: Ref<AgentProvider>;
    readonly account: Ref<string | undefined>;
    // Dropped when the daemon no longer has the session behind this chat.
    readonly session: Ref<SessionRef | undefined>;
    // The red line: this needs the user.
    readonly error: Ref<string | null>;
    // A probe stands down while a turn is live — the run it was hunting is already here.
    readonly streaming: Ref<boolean>;
    // Take the user's undelivered message back out of the transcript and hold it in the queue, where it waits
    // for their own next send rather than flushing into a turn nobody asked for.
    requeue(userMessageId: number): void;
    // Hold the queue where it is, without taking anything back: a message waiting behind a killed turn must not
    // race the daemon's resume to POST /agent and lose with "this agent already has a turn running".
    hold(): void;
    // Attach to a run the daemon restarted; whether one was found.
    reattach(): Promise<boolean>;
    // Mirror the transcript to the local cache — a notice this raised is part of the conversation.
    persist(): void;
}

export class TurnFailures {
    /* The outage this conversation is waiting out. Cleared by the next turn starting, which is either the resume
     * landing or the user's own send superseding it. */
    readonly outageResume = ref<OutageResume | undefined>();

    /* A credential renewal this conversation is waiting out — set the moment the API refuses this turn's token and
     * cleared by whatever ends the wait: the resumed turn attaching (beginTurn), or the probe budget running out
     * with nothing to attach to (giveUpOnRenewal). Its presence IS the spinner on the notice line, which is why
     * it carries the instant it started rather than a bare flag: it is the only thing that can say how long the
     * wait has been going, and a wait with no readout is the thing that reads as a hang.
     *
     * There is no instant to count DOWN to here, unlike an outage: the re-mint either works on the next scheduler
     * pass (a few seconds) or the credential is dead. So the honest readout is elapsed, not remaining. */
    readonly credentialRenewal = ref<{ since: number } | undefined>();

    // Timer for the pending probe (armed by a scheduled resume, re-armed between attempts); one per
    // conversation, so a fresh failure's schedule replaces a stale one.
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly host: FailureHost) {}

    // How a turn-level failure READS.
    apply(error: TurnError, turn: TurnContext): void {
        const { message, code } = error;
        switch (code) {
            case `claude-reauth`:
                /* The Claude credential is dead and the daemon refused the turn before running any of it. Nothing
                 * was processed, so the message is not part of the conversation yet — pull the bubble back out of
                 * the transcript and return it to the queue, which is exactly what the queue means (written, not
                 * delivered) and what makes reconnecting REPLAY it instead of asking the user to retype into every
                 * chat that bounced. The queue is held until then, so it can't immediately re-fail. */
                this.host.requeue(turn.userMessageId);
                this.markReauth(message);
                // Muted, like session-not-found: the condition has a one-click fix sitting right above the composer
                // (ChatPanel's reauth banner, which this needsReauth flag raises), so the red line would overstate it.
                this.host.transcript.notice(`${message} Your message is held here and goes as soon as the account is back.`);
                return;
            case `codex-reauth`:
                // The daemon rejected this account's credential before the turn. Same badge as claude-reauth (the
                // account IS connected, its grant is dead), but the red line too: there is no held message to
                // replay here, so nothing else would tell the user the turn didn't happen.
                this.markReauth(message);
                this.host.error.value = message;
                return;
            case `claude-token-refused`:
                this.applyAuthRefusedError(error);
                return;
            case `unknown-command`:
                /* The harness claimed the leading `/` as a command name it doesn't have and threw the rest of the
                 * message away — nothing ran, and the words are not in the transcript the daemon stores either.
                 * So this is the claude-reauth shape rather than a red line: pull the bubble back out and hold the
                 * text, which is the only copy of it left.
                 *
                 * Held because the queue would otherwise flush the moment this turn settles, re-sending a message
                 * the harness just ate without the user asking — and if the daemon still can't tell the leading
                 * token from a command (an unlearned list is the only way this frame is reached), that is a loop
                 * rather than a recovery. The turn did teach it the list, so the user's own next send is the one
                 * that goes through. */
                this.host.requeue(turn.userMessageId);
                this.host.transcript.notice(`${message} Your message is held below — send it again and it goes as written.`);
                return;
            case `session-not-found`:
                // The sandbox no longer has this chat's transcript — drop the dead session so the next send starts
                // a fresh one instead of replaying the failure forever. A muted notice, not the error ref: the
                // condition is self-healed, so the red line + error tab status would overstate it.
                this.host.session.value = undefined;
                this.host.transcript.notice(
                    `This chat's server-side history is gone (the sandbox was rebuilt or the session was deleted). Your last message wasn't processed — send it again; a fresh session starts, seeded with this window's transcript.`,
                );
                return;
            case `codex-advisory`:
                // Codex warned about the turn it then ran to completion (its pinned CLI has no metadata for a model
                // the subscription already serves, so the turn runs on fallback context/compaction limits). The red
                // line said the turn had failed, directly under the answer it had just produced. Muted, like the
                // other codes that describe a turn rather than end one.
                this.host.transcript.notice(message);
                return;
            case `rate_limit`:
                this.applyLimitError(error);
                return;
            case `provider-outage`:
                this.applyOutageError(error, turn);
                return;
            case `grok-model-invalid`:
            case `codex-model-invalid`:
                // The daemon rejected the pinned model. Grok self-heals mid-turn (re-prompting with a model xAI
                // named), so its code reaches us only when that failed; Codex can't (OpenAI names no alternative),
                // so its code always lands here. Either way: surface it (red) and reload the provider's live catalog
                // so the picker — and any conversation still pinning the dead id — repoints to what the daemon
                // actually serves. Dynamic import breaks the static cycle (useChat imports the conversation).
                void import(`./useChat`).then((chat) => chat.loadProviderModels(this.host.provider.value));
                this.host.error.value = message;
                return;
            default:
                // `subscription-required`, `agent-busy`, and every uncoded failure: the red line and nothing else.
                this.host.error.value = message;
                return;
        }
    }

    // Light the reauth badge on the account this conversation's turn ran under, so the fix is offered where the
    // user already is instead of waiting for the next status load to discover it. Both reauth codes mean the
    // same thing about the account and differ only in how the turn itself reads, so they mark it the same way.
    private markReauth(detail: string): void {
        markAccountReauth(this.host.provider.value, this.host.account.value, detail);
    }

    /* Claude's subscription usage cap, not a crash — the daemon's message renders as a muted notice (like
     * session-not-found) rather than the red error ref, so it reads as "wait and retry" instead of "the
     * workspace broke". Nothing re-runs the turn: unlike an outage or a rotated token, the allowance is the
     * user's OWN budget, so naming the reset instant and leaving the next send to them is the whole response.
     * The frame's own reset instant wins over the usage store's binding window (the frame names the pool that
     * actually refused). */
    private applyLimitError(error: TurnError): void {
        const { message } = error;
        const resetsAt = error.resetsAt ?? bindingWindow(usageStatusFor(this.host.account.value))?.resetsAt;
        if (resetsAt === undefined) {
            this.host.transcript.notice(message);
            return;
        }
        this.host.transcript.notice(`${message} Resets ${formatReset(resetsAt)}.`);
    }

    /* THE PROVIDER FAILED, AND SOMETHING IS ALREADY BEING DONE ABOUT IT.
     *
     * Muted rather than red, for the same reason a spent allowance is: the red line means "this needs you", and
     * the whole point of the resume is that it doesn't. What the user needs to know instead is the three things a
     * red line cannot say — that the provider was at fault and not their work, that the turn is coming back, and
     * WHEN. The wait is escalating (30s to 20 minutes as an outage drags on), so naming the instant matters more
     * here than it does for a limit: "retrying" alone, on a wait that silently grows, is indistinguishable from
     * nothing happening.
     *
     * The one-press opt-out rides the notice because this is the moment of regret — the automation just fired, and
     * anyone who did not want it wants it gone now, not after a trip to Sandbox ▸ Agent.
     *
     * With no resume armed (the daemon's attempts are spent, so `outage` is absent) this is a plain failure and
     * gets the red line: promising a retry that will not come is worse than admitting the turn is dead. The user's
     * words are handed back either way — the message never reached the model, and a 500 that eats what somebody
     * typed is the one part of this failure that is genuinely our fault. */
    private applyOutageError(error: TurnError, turn: TurnContext): void {
        const { message, outage } = error;
        if (outage === undefined) {
            this.host.requeue(turn.userMessageId);
            this.host.error.value = message;
            return;
        }
        const scheduled = error.autoResume === `scheduled`;
        this.outageResume.value = { ...outage, scheduled };
        this.host.transcript.notice(
            scheduled
                ? `${message} Retrying by itself in ${formatWait(outage.retryAt)} — attempt ${outage.attempt} of ${outage.maxAttempts}.`
                : `${message} Auto-resume is off, so this turn is waiting: turn it on and it continues from here.`,
            scheduled ? { noticeAction: `outageOptOut` } : undefined,
        );
        if (scheduled) {
            this.scheduleReattach(outage.retryAt * 1000, OUTAGE_PROBE);
        }
    }

    /* THE CREDENTIAL WAS REFUSED MID-TURN, AND THE TURN IS ALREADY ON ITS WAY BACK.
     *
     * Almost always a rotation the daemon itself performed: Anthropic retires an access token the instant its
     * successor is minted, and a turn's token is snapshotted into the agent subprocess at spawn, so one rotation
     * 401s every turn holding it at once. Nobody's work was wrong and nobody has anything to fix — the daemon
     * re-mints and re-runs each of them within a scheduler pass (turn-resume.ts).
     *
     * So: muted, phrased as an interruption being undone, and — the part that was missing — actually WATCHED.
     * The resumed run is a fresh detached run on this same conversation, and nothing in a pull-based attach model
     * would have brought it to this window; the notice promised a continuation the tab then never showed, while
     * /agents happily reported the same agent working. The queue is held over the same gap, so a message waiting
     * behind the killed turn doesn't race the daemon's resume to POST /agent.
     *
     * With no renewal armed (`autoResume` absent) nothing is coming: the credential is dead, or this turn was
     * itself a resume that got refused again. That is the one case where the user really is needed, so it reads
     * as the reconnect condition rather than a spinner. */
    private applyAuthRefusedError(error: TurnError): void {
        const { message } = error;
        if (error.autoResume !== `scheduled`) {
            this.markReauth(message);
            this.host.transcript.notice(`${message} Reconnect the account to pick this conversation back up.`);
            return;
        }
        this.host.hold();
        // The wait opens here; armRenewalProbe arms the hunt that closes it, once this turn's stream is done.
        this.credentialRenewal.value = { since: Date.now() };
        this.host.transcript.notice(`${message} The credential is being renewed and this turn continues automatically.`, {
            noticeWait: `credentialRenewal`,
        });
    }

    /* A credential wait opened by a turn's failure starts hunting for its replacement when that turn ENDS rather
     * than at the frame that opened it. The frame arrives mid-stream — the harness still has a `done` to send and
     * the daemon a finally to run — and a probe that fires into that tail finds the conversation streaming, reads
     * it as "the run I was looking for is already here", and abandons the hunt. Which is the very bug this exists
     * to fix, reintroduced one second later.
     *
     * Armed only when the wait is still open: a turn that ended for any other reason has nothing to hunt. */
    armRenewalProbe(): void {
        if (this.credentialRenewal.value === undefined) {
            return;
        }
        this.scheduleReattach(Date.now(), RENEWAL_PROBE, () => this.giveUpOnRenewal());
    }

    // The user has just enabled resuming for an outage that stranded this turn: the daemon remembered the turn
    // whatever the setting said, so the save alone arms it and this window only has to reflect that and be there
    // when it lands.
    armOutageResume(): void {
        const pending = this.outageResume.value;
        if (pending === undefined) {
            return;
        }
        this.outageResume.value = { ...pending, scheduled: true };
        this.host.transcript.notice(`Auto-resume enabled — this chat retries by itself in ${formatWait(pending.retryAt)}.`);
        this.scheduleReattach(pending.retryAt * 1000, OUTAGE_PROBE);
        this.host.persist();
    }

    // A turn is running on this conversation, so both waits are over: the resume landed, or the user's own send
    // superseded it. The daemon cleared its side at this turn's start, so the offer banner and the renewal
    // spinner must not outlive the failures they described.
    clear(): void {
        this.outageResume.value = undefined;
        this.credentialRenewal.value = undefined;
    }

    /* Hunt for the run the daemon restarted: first probe at `dueAt` + the profile's delay (a beat AFTER the
     * daemon is expected to fire), then on its cadence until the resumed run answers or the attempts run out.
     * Takes an instant rather than an attempt number because for an outage that instant moves with the backoff.
     *
     * `exhausted` runs when the whole budget went by without a run to attach to — the resume did not happen, and
     * a caller that promised the user one has to withdraw that promise rather than leave it hanging. */
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

    // Called off a send (which supersedes whatever the probe was hunting) and off a closed tab or sandbox switch
    // — the daemon still fires the resume, and reopening the conversation replays it like any other detached run.
    cancelProbe(): void {
        clearTimeout(this.timer);
    }

    // The probe budget went by with nothing to attach to, so the re-mint never produced a working credential.
    // Stop spinning and say what is true now: this turn is not coming back on its own, and the account is the
    // thing that needs fixing.
    private giveUpOnRenewal(): void {
        if (this.credentialRenewal.value === undefined) {
            return;
        }
        this.credentialRenewal.value = undefined;
        const detail = `Claude sign-in could not be renewed — reconnect the account.`;
        this.markReauth(detail);
        this.host.transcript.notice(`${detail} This turn stopped where it was; sending again picks the conversation back up.`);
        this.host.persist();
    }
}
