import type { NoticeModel } from "@intentic/ui";
import { noticeFrom,useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, type Ref, ref } from "vue";
import { useAuth } from "../../client/auth/useAuth";
import { CODE_LENGTH, codeDigits, codeSpent, EmailCodeError, plausibleAddress } from "../../client/auth/emailCode";

// THE EMAILED-CODE SIGN-IN, as one small machine every screen that offers it shares (Login.vue, AcceptInvite.vue,
// LoginConfirm.vue): an address, then the six digits the platform mailed to it. One mail carries one code, offered two
// ways, typed here or followed from the mail's link; either spends it, so a link opened on another device leaves this
// screen holding a code that no longer signs in, and the way on is a fresh one.

// How long a fresh code holds the resend button back: the platform limits how often one address is mailed (HTTP 429),
// and a countdown says so before the refusal does.
export const RESEND_AFTER_MS = 60_000;

export type EmailCodeStep = `address` | `code`;

export const useEmailCode = (options: { readonly lockedEmail?: Readonly<Ref<string | undefined>>; readonly onSignedIn: () => void | Promise<void> }) => {
    const t = useT();
    const { sendEmailCode, signInWithEmailCode } = useAuth();

    const typed = ref(``);
    // The invite's address when there is one: the platform accepts the invite only for it, so no other is offered.
    const address = computed(() => (options.lockedEmail?.value ?? typed.value).trim());
    const step = ref<EmailCodeStep>(`address`);
    // The address the code went to, kept apart from the field so editing it after sending cannot pair the code with
    // another address.
    const sentTo = ref<string>();
    const code = ref(``);
    const sending = ref(false);
    const verifying = ref(false);
    const notice = ref<NoticeModel>();
    // Whether the last refusal spent the code (wrong too often, run out), so the screen puts "send a new code" first.
    const needsNewCode = ref(false);
    const resendAt = ref<number>();

    const now = useNow(() => resendAt.value !== undefined);
    const resendInSeconds = computed(() => (resendAt.value === undefined ? 0 : Math.max(0, Math.ceil((resendAt.value - now.value) / 1000))));
    const canSend = computed(() => !sending.value && plausibleAddress(address.value));
    const canResend = computed(() => !sending.value && resendInSeconds.value === 0);
    const canVerify = computed(() => !verifying.value && code.value.length === CODE_LENGTH);

    const mail = async (to: string): Promise<boolean> => {
        sending.value = true;
        notice.value = undefined;
        try {
            await sendEmailCode(to);
            sentTo.value = to;
            needsNewCode.value = false;
            code.value = ``;
            resendAt.value = Date.now() + RESEND_AFTER_MS;
            return true;
        } catch (error) {
            notice.value = noticeFrom(error, t(`auth.emailCode.sendFailed`), { tone: `warning` });
            // The platform said wait: the countdown says how long, rather than a button that would be refused again.
            if (error instanceof EmailCodeError && error.refusal === `rate-limited`) {
                resendAt.value = Date.now() + RESEND_AFTER_MS;
            }
            return false;
        } finally {
            sending.value = false;
        }
    };

    const send = async (): Promise<void> => {
        if (!canSend.value) {
            return;
        }
        if (await mail(address.value.toLowerCase())) {
            step.value = `code`;
        }
    };

    const resend = async (): Promise<void> => {
        const to = sentTo.value;
        if (to === undefined || !canResend.value) {
            return;
        }
        await mail(to);
    };

    const verify = async (): Promise<void> => {
        const to = sentTo.value;
        if (to === undefined || !canVerify.value) {
            return;
        }
        verifying.value = true;
        notice.value = undefined;
        try {
            await signInWithEmailCode(to, code.value);
            await options.onSignedIn();
        } catch (error) {
            notice.value = noticeFrom(error, t(`auth.emailCode.signInFailed`), { tone: `warning` });
            needsNewCode.value = error instanceof EmailCodeError && codeSpent(error.refusal);
        } finally {
            verifying.value = false;
        }
    };

    // Six digits typed or pasted are the whole of what this step asks, so the last one submits it.
    const typeCode = (value: string): void => {
        code.value = codeDigits(value);
        if (code.value.length === CODE_LENGTH) {
            void verify();
        }
    };

    // Back to the address; the code that went out stays good, but it is the next one this screen will ask for.
    const changeAddress = (): void => {
        step.value = `address`;
        code.value = ``;
        notice.value = undefined;
        needsNewCode.value = false;
    };

    return {
        typed,
        address,
        step,
        sentTo,
        code,
        sending,
        verifying,
        notice,
        needsNewCode,
        resendInSeconds,
        canSend,
        canResend,
        canVerify,
        send,
        resend,
        verify,
        typeCode,
        changeAddress,
    };
};
