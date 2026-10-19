import { connectTripNote } from "./connectFlowNotes";

describe(`connectTripNote`, () => {
    it(`warns about Google's Antigravity page and offers another provider`, () => {
        const note = connectTripNote(`gemini`, { redirect: true });
        expect(note?.offerElsewhere).toBe(true);
        expect(note?.text).toContain(`Google Antigravity`);
    });

    it(`mentions Devin's token only where its last page shows one`, () => {
        expect(connectTripNote(`devin`, { redirect: false })?.text).toContain(`token`);
        expect(connectTripNote(`devin`, { redirect: true })?.text).not.toContain(`token`);
        expect(connectTripNote(`devin`, { redirect: true })?.offerElsewhere).toBe(false);
    });

    it(`has nothing to add for a provider whose pages carry its own name`, () => {
        expect(connectTripNote(`claude`, { redirect: false })).toBeUndefined();
    });
});
