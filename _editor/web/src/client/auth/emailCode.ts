import { t } from "@intentic/ui/i18n";

// The platform's answers to a mailed sign-in code, as the screens that ask for one say them. Better Auth's email-OTP
// plugin answers the same whether or not an account holds the address, so nothing here can tell anybody that; what it
// can say is that the code was wrong, ran out, was guessed at too often, or that the platform wants a minute's rest.

// A code the person can do something about, by name; `failed` is everything else, said in the platform's own words.
export type EmailCodeRefusal = `rate-limited` | `invalid` | `expired` | `too-many-attempts` | `failed`;

export class EmailCodeError extends Error {
    constructor(
        readonly refusal: EmailCodeRefusal,
        message: string,
    ) {
        super(message);
    }
}

// The shape Better Auth's client hands back as `error`: a status always, a code from the plugin's own table sometimes.
export interface AuthClientError {
    readonly status?: number;
    readonly code?: string;
    readonly message?: string;
}

export const refusalOf = (error: AuthClientError): EmailCodeRefusal => {
    if (error.status === 429) {
        return `rate-limited`;
    }
    switch (error.code) {
        case `INVALID_OTP`: {
            return `invalid`;
        }
        case `OTP_EXPIRED`: {
            return `expired`;
        }
        case `TOO_MANY_ATTEMPTS`: {
            return `too-many-attempts`;
        }
        default: {
            return `failed`;
        }
    }
};

// Words are built when they are read (docs/architecture/languages.md), so this runs at the refusal, not at import.
const sentenceFor = (refusal: EmailCodeRefusal, error: AuthClientError, fallback: string): string => {
    switch (refusal) {
        case `rate-limited`: {
            return t(`auth.emailCode.rateLimited`);
        }
        case `invalid`: {
            return t(`auth.emailCode.invalid`);
        }
        case `expired`: {
            return t(`auth.emailCode.expired`);
        }
        case `too-many-attempts`: {
            return t(`auth.emailCode.tooManyAttempts`);
        }
        default: {
            return error.message ?? fallback;
        }
    }
};

export const emailCodeError = (error: AuthClientError, fallback: string): EmailCodeError => {
    const refusal = refusalOf(error);
    return new EmailCodeError(refusal, sentenceFor(refusal, error, fallback));
};

// Whether a refusal used the code up (it ran out, or was guessed at too often), so the screen puts mailing a fresh one
// first; a mistyped code is still good for another try.
export const codeSpent = (refusal: EmailCodeRefusal): boolean => refusal === `expired` || refusal === `too-many-attempts`;

// Six digits, as the platform mails them; whatever else was pasted with them (spaces, a dash) is not part of the code.
export const CODE_LENGTH = 6;
export const codeDigits = (typed: string): string => typed.replaceAll(/\D/g, ``).slice(0, CODE_LENGTH);

// A plausible address, the same test the invite form uses: the platform is the judge, this only keeps the button honest.
export const plausibleAddress = (value: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
