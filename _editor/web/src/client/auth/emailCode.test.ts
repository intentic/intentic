import { codeDigits, codeSpent, EmailCodeError, emailCodeError, type EmailCodeRefusal, plausibleAddress, refusalOf } from "./emailCode";

// The platform's answers to a mailed code, named so the screens can say what to do: wait, retype, or ask for a new one.
// Everything else is said in the platform's own words.

describe(`refusalOf`, () => {
    it(`names the rate limit by its status, whatever the code says`, () => {
        expect(refusalOf({ status: 429, code: `INVALID_OTP` })).toBe(`rate-limited`);
    });

    it(`names the email-OTP plugin's own codes`, () => {
        expect([`INVALID_OTP`, `OTP_EXPIRED`, `TOO_MANY_ATTEMPTS`].map((code) => refusalOf({ status: 400, code }))).toEqual([
            `invalid`,
            `expired`,
            `too-many-attempts`,
        ]);
    });

    it(`calls anything else a failure`, () => {
        expect(refusalOf({ status: 500 })).toBe(`failed`);
        expect(refusalOf({ status: 400, code: `SOMETHING_NEW` })).toBe(`failed`);
    });
});

describe(`emailCodeError`, () => {
    it(`says a named refusal in this app's words`, () => {
        const error = emailCodeError({ status: 429, message: `Too many requests` }, `Couldn't send the code.`);
        expect(error).toBeInstanceOf(EmailCodeError);
        expect({ refusal: error.refusal, message: error.message }).toEqual({
            refusal: `rate-limited`,
            message: `Too many codes asked for at once. Wait a minute, then try again.`,
        });
    });

    it(`says any other in the platform's words, or the caller's when it gave none`, () => {
        expect(emailCodeError({ status: 500, message: `mail is down` }, `Couldn't send the code.`).message).toBe(`mail is down`);
        expect(emailCodeError({ status: 500 }, `Couldn't send the code.`).message).toBe(`Couldn't send the code.`);
    });
});

describe(`the code itself`, () => {
    // A code is good for another try after a typo; it is used up only once it ran out or was guessed at too often.
    it(`is spent only by running out or by too many tries`, () => {
        const refusals: readonly EmailCodeRefusal[] = [`expired`, `too-many-attempts`, `invalid`, `rate-limited`, `failed`];
        expect(refusals.map((refusal) => codeSpent(refusal))).toEqual([
            true,
            true,
            false,
            false,
            false,
        ]);
    });

    it(`is six digits, whatever was pasted around them`, () => {
        expect(codeDigits(` 123-456 `)).toBe(`123456`);
        expect(codeDigits(`12345678`)).toBe(`123456`);
        expect(codeDigits(`abc`)).toBe(``);
    });
});

describe(`plausibleAddress`, () => {
    it(`holds the button until the address could be one`, () => {
        expect(plausibleAddress(`ana@corp.example`)).toBe(true);
        expect(plausibleAddress(`  ana@corp.example  `)).toBe(true);
        expect(plausibleAddress(`ana@corp`)).toBe(false);
        expect(plausibleAddress(`ana corp.example`)).toBe(false);
    });
});
