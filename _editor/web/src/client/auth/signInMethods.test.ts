import { emailOnly, googleMailbox, methodsOf, signsInByEmail, signsInWithGoogle } from "./signInMethods";

// Which ways in an account has, as the session module and the screens read them: an old platform's silence is a Google
// account, and only an account with no Google sign-in is kept from Google's prompt.

describe(`an account's ways in`, () => {
    it(`reads a platform's silence as the Google account every account was before email sign-in`, () => {
        expect(methodsOf(undefined)).toEqual([`google`]);
        expect({ email: signsInByEmail(undefined), google: signsInWithGoogle(undefined), only: emailOnly(undefined) }).toEqual({
            email: false,
            google: true,
            only: false,
        });
    });

    it(`keeps only an account with no Google sign-in from Google's prompt`, () => {
        expect(emailOnly([`email`])).toBe(true);
        expect(emailOnly([`google`, `email`])).toBe(false);
        expect(emailOnly([`google`])).toBe(false);
        // An account the platform says has no way in at all is not one Google can be withheld from on its word.
        expect(emailOnly([])).toBe(false);
    });
});

describe(`googleMailbox`, () => {
    // Built from parts, so the addresses read as what a person types rather than as anybody's.
    const at = (domain: string): string => [`ana`, domain].join(`@`);

    it(`knows the two domains Google holds, whatever their case or the spaces around them`, () => {
        expect(googleMailbox(at(`gmail.com`))).toBe(true);
        expect(googleMailbox(` ${at(`GoogleMail.COM`)} `)).toBe(true);
        expect(googleMailbox(at(`gmail.com.example`))).toBe(false);
        expect(googleMailbox(at(`corp.example`))).toBe(false);
    });
});
