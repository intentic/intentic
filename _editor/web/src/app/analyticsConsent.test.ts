import { asksFirstIn } from "./analyticsConsent";

// Who is asked before anything is recorded: the EEA, the UK and Switzerland by their browser's time zone, erring
// towards asking.
describe(`asksFirstIn`, () => {
    it(`asks a browser in a European zone, including the EEA's zones outside Europe/`, () => {
        for (const zone of [`Europe/Warsaw`, `Europe/London`, `Europe/Zurich`, `Asia/Nicosia`, `Atlantic/Canary`, `Indian/Reunion`]) {
            expect(asksFirstIn(zone)).toBe(true);
        }
    });

    it(`does not ask a browser elsewhere`, () => {
        for (const zone of [`America/New_York`, `Asia/Tokyo`, `UTC`, `Australia/Sydney`]) {
            expect(asksFirstIn(zone)).toBe(false);
        }
    });

    it(`does not ask when there is no zone to read here (the caller treats that as asking)`, () => {
        expect(asksFirstIn(undefined)).toBe(false);
    });
});
