import { EMAIL_SIGN_IN_OFF, PLATFORM_KEY_UNKNOWN } from "@intentic/sandbox-contract/schemas/system";
import { t } from "@intentic/ui/i18n";

// The platform's word that this account is not in the sandbox (an invitation withdrawn, or not accepted yet): its mint
// answers NOT_FOUND, which no retry lifts, so it is said by name. (2026-10-26: it read as "try again in a moment", and a
// member pressed "Continue as" over and over against it.)
export const NOT_A_MEMBER = `not-a-member`;

// The daemon's named refusals of the platform's identity assertion (sandbox-contract schemas/system.ts), and three for
// one that never reached it: the platform counts this account out of the sandbox, would not mint one, or the daemon
// refused it bare.
export type EmailRefusal = typeof EMAIL_SIGN_IN_OFF | typeof PLATFORM_KEY_UNKNOWN | typeof NOT_A_MEMBER | `rejected` | `unavailable`;

// Words are built when read (languages.md), so a refusal is said in the language of the moment it is shown.
export const emailRefusalText = (refusal: EmailRefusal): string => {
    switch (refusal) {
        case EMAIL_SIGN_IN_OFF: {
            return t(`sandbox.sandboxSession.emailSignInOff`);
        }
        case PLATFORM_KEY_UNKNOWN: {
            return t(`sandbox.sandboxSession.platformKeyUnknown`);
        }
        case NOT_A_MEMBER: {
            return t(`sandbox.sandboxSession.notAMember`);
        }
        case `rejected`: {
            return t(`sandbox.sandboxSession.assertionRejected`);
        }
        default: {
            return t(`sandbox.sandboxSession.assertionUnavailable`);
        }
    }
};
