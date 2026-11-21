import { onScopeDispose, type Ref, ref } from "vue";
import { track } from "../../app/analytics";
import { googleMailbox } from "../../client/auth/signInMethods";
import { EmailCodeError, type EmailCodeRefusal } from "../../client/auth/emailCode";

// WHAT BECAME OF AN EMAILED-CODE SIGN-IN, as analytics counts it, and the wait on the code step that offers help. Until
// 2026-11 this road sent nothing: of 15 people who started it, 7 never signed in, and one sat 43 minutes on the code
// step without typing. No event carries the address or the code, nor any part of either.

// How long the code step sits with nothing typed before it offers help (spam, a new code, Google) and counts the wait.
export const WAIT_HELP_MS = 60_000;

// The screen the block is on: /login (the desktop app's too), the in-app sign-in dialog, an invite's page, and the
// mail's link page (LoginConfirm.vue: its own Confirm press, and the block it offers once the link failed).
export type EmailCodeSurface = `login` | `dialog` | `invite` | `confirm`;

// Why a step did not go through: the platform's refusal by name, `network` for a request that got no answer, `error`
// for anything else (a sign-in the sandbox side refused after the code was taken).
export type EmailCodeFailure = EmailCodeRefusal | `network` | `error`;

export const failureReason = (error: Error | undefined): EmailCodeFailure => {
    if (error instanceof EmailCodeError) {
        return error.refusal;
    }
    return error instanceof TypeError ? `network` : `error`;
};

export type EmailCodeStage = `send` | `resend` | `verify` | `link`;

export type Track = typeof track;

interface EventOptions {
    readonly surface: EmailCodeSurface;
    readonly track?: Track | undefined;
    // Google's sign-in is on the same screen and the address is the reader's to choose: the Google hint's case.
    readonly googleOffered?: Readonly<Ref<boolean>> | undefined;
    readonly lockedEmail?: Readonly<Ref<string | undefined>> | undefined;
}

// `untouched`: whether the code step still sits with nothing typed and nothing being checked as the wait runs out.
export const useEmailCodeEvents = (options: EventOptions, untouched: () => boolean) => {
    const report = options.track ?? track;
    const { surface } = options;
    // The help line is up: the code step waited WAIT_HELP_MS with nothing typed. Counted once per block.
    const waitedLong = ref(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let counted = false;

    const stopWaiting = (): void => {
        clearTimeout(timer);
        timer = undefined;
    };
    onScopeDispose(stopWaiting);

    // From each code mailed: a reader who has typed nothing by the end of it is likely looking at an empty inbox.
    const startWaiting = (): void => {
        stopWaiting();
        timer = setTimeout(() => {
            timer = undefined;
            if (!untouched()) {
                return;
            }
            waitedLong.value = true;
            if (!counted) {
                counted = true;
                report(`signin_code_waiting`, { surface });
            }
        }, WAIT_HELP_MS);
    };

    // Back to the address: the next code mailed starts the wait afresh.
    const reset = (): void => {
        stopWaiting();
        waitedLong.value = false;
    };

    // A code asked for, counted as the press lands so a send the platform refuses is still a request. The first send
    // says, where the Google hint applies, whether the address was a Google one.
    const asked = (stage: `send` | `resend`, to: string): void => {
        if (stage === `resend`) {
            report(`signin_code_resent`, { surface, help_shown: waitedLong.value });
            return;
        }
        const hinted = options.googleOffered?.value === true && options.lockedEmail?.value === undefined;
        report(`signin_code_requested`, hinted ? { surface, google_address: googleMailbox(to) } : { surface });
    };

    const failed = (stage: EmailCodeStage, error: Error | undefined): void => {
        report(`signin_code_failed`, { surface, stage, reason: failureReason(error) });
    };

    return {
        waitedLong,
        reset,
        // Mails a code through `work`, counting the ask and a refusal; a code that went out starts the wait. Rethrows.
        mail: async (stage: `send` | `resend`, to: string, work: () => Promise<void>): Promise<void> => {
            asked(stage, to);
            try {
                await work();
            } catch (error) {
                failed(stage, error instanceof Error ? error : undefined);
                throw error;
            }
            startWaiting();
        },
        // Spends the code through `work`, counting the sign-in or its refusal. Rethrows.
        verify: async (work: () => Promise<void>): Promise<void> => {
            try {
                await work();
            } catch (error) {
                failed(`verify`, error instanceof Error ? error : undefined);
                throw error;
            }
            stopWaiting();
            report(`signin_completed`, { method: `email`, via: `code`, surface, help_shown: waitedLong.value });
        },
    };
};
