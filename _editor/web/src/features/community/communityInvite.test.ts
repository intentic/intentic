import {
    dotShown,
    finishedAsks,
    type InviteFacts,
    type InviteRecord,
    markAnswered,
    markAsked,
    menuMayAsk,
    noteEngagement,
    noteShown,
} from "./communityInvite";

// Pins when the editor asks somebody to join the community: never on the day they learn the loop (the finished
// checklist speaks for that day), once on a later day for whoever has been round it, and never again once it has been
// seen and left, or answered either way.

const MONDAY_10AM = new Date(2026, 9, 12, 10).getTime();
const MONDAY_6PM = new Date(2026, 9, 12, 18).getTime();
const TUESDAY_9AM = new Date(2026, 9, 13, 9).getTime();

const facts = (overrides: Partial<InviteFacts> = {}): InviteFacts => ({ canShip: true, landed: false, established: false, ...overrides });
const NONE: InviteRecord = {};

describe(`who counts as having got somewhere`, () => {
    it(`writes the first moment work is seen landed, and never moves it`, () => {
        const first = noteEngagement(NONE, facts({ landed: true }), MONDAY_10AM);
        expect(first.engagedAt).toBe(MONDAY_10AM);
        expect(noteEngagement(first, facts({ landed: true }), TUESDAY_9AM)).toBe(first);
    });

    it(`counts a sandbox long in use as engaged, landed or not`, () => {
        expect(noteEngagement(NONE, facts({ established: true }), MONDAY_10AM).engagedAt).toBe(MONDAY_10AM);
    });

    it(`does not count someone watching another person's sandbox`, () => {
        expect(noteEngagement(NONE, facts({ canShip: false, landed: true }), MONDAY_10AM)).toBe(NONE);
    });

    it(`does not count a first run that has not landed anything yet`, () => {
        expect(noteEngagement(NONE, facts(), MONDAY_10AM)).toBe(NONE);
    });
});

describe(`when the account menu asks`, () => {
    const engagedMonday: InviteRecord = { engagedAt: MONDAY_10AM };

    it(`leaves the day of the first land alone`, () => {
        expect(menuMayAsk(engagedMonday, facts({ landed: true }), MONDAY_6PM)).toBe(false);
        expect(dotShown(engagedMonday, facts({ landed: true }), MONDAY_6PM)).toBe(false);
    });

    it(`asks when they come back on a later day`, () => {
        expect(menuMayAsk(engagedMonday, facts({ landed: true }), TUESDAY_9AM)).toBe(true);
        expect(dotShown(engagedMonday, facts({ landed: true }), TUESDAY_9AM)).toBe(true);
        expect(noteShown(engagedMonday, facts({ landed: true }), TUESDAY_9AM, TUESDAY_9AM)).toBe(true);
    });

    it(`asks a long-standing user without waiting a day`, () => {
        expect(menuMayAsk(NONE, facts({ established: true }), MONDAY_10AM)).toBe(true);
    });

    it(`never asks someone who cannot run the sandbox`, () => {
        expect(menuMayAsk(engagedMonday, facts({ canShip: false, landed: true }), TUESDAY_9AM)).toBe(false);
    });

    it(`drops the dot once the note has been seen, and keeps the note for that visit only`, () => {
        const pageOpened = TUESDAY_9AM;
        const asked = markAsked(engagedMonday, TUESDAY_9AM + 1_000);
        expect(dotShown(asked, facts({ landed: true }), TUESDAY_9AM + 2_000)).toBe(false);
        expect(noteShown(asked, facts({ landed: true }), TUESDAY_9AM + 2_000, pageOpened)).toBe(true);
        // The next page load: the note seen and left alone is the plain row again.
        const nextVisit = TUESDAY_9AM + 3_600_000;
        expect(noteShown(asked, facts({ landed: true }), nextVisit, nextVisit)).toBe(false);
    });

    it(`does not ask in the menu after the finished checklist already asked`, () => {
        const askedByChecklist = markAsked(engagedMonday, MONDAY_10AM);
        expect(dotShown(askedByChecklist, facts({ landed: true }), TUESDAY_9AM)).toBe(false);
        expect(noteShown(askedByChecklist, facts({ landed: true }), TUESDAY_9AM, TUESDAY_9AM)).toBe(false);
    });
});

describe(`an answer`, () => {
    it(`puts the ask away everywhere, whichever it was`, () => {
        for (const answer of [`joined`, `declined`] as const) {
            const answered = markAnswered({ engagedAt: MONDAY_10AM }, answer, TUESDAY_9AM);
            expect(answered.closed).toBe(answer);
            expect(menuMayAsk(answered, facts({ landed: true }), TUESDAY_9AM)).toBe(false);
            expect(noteShown(answered, facts({ landed: true }), TUESDAY_9AM, TUESDAY_9AM)).toBe(false);
            expect(finishedAsks(answered)).toBe(false);
        }
    });

    it(`counts a join through the plain row as asked and answered`, () => {
        const joined = markAnswered(NONE, `joined`, MONDAY_10AM);
        expect(joined.askedAt).toBe(MONDAY_10AM);
        expect(finishedAsks(joined)).toBe(false);
    });

    it(`keeps the first answer`, () => {
        const declined = markAnswered(NONE, `declined`, MONDAY_10AM);
        expect(markAnswered(declined, `joined`, TUESDAY_9AM)).toBe(declined);
    });

    it(`leaves the finished checklist free to ask until then`, () => {
        expect(finishedAsks(NONE)).toBe(true);
        expect(finishedAsks(markAsked(NONE, MONDAY_10AM))).toBe(true);
    });
});
