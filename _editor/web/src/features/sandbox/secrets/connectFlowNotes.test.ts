import { t } from "@intentic/ui/i18n";
import { connectTripNote } from "./connectFlowNotes";

// Every word a note's signs carry, shown and meant, to check what the reader will be told.
const wordsOf = (note: ReturnType<typeof connectTripNote>): string[] => (note?.signs ?? []).flatMap((sign) => [sign.shows, sign.means]);

describe(`connectTripNote`, () => {
    it(`warns about Google's Antigravity page and offers another provider`, () => {
        const note = connectTripNote(`gemini`, { redirect: true });
        expect(note?.offerElsewhere).toBe(true);
        expect(wordsOf(note)).toContain(`Google Antigravity`);
        expect(note?.signs.some((sign) => sign.warning)).toBe(true);
    });

    it(`mentions Devin's token only where its last page shows one`, () => {
        expect(connectTripNote(`devin`, { redirect: false })?.signs.map((sign) => sign.shows)).toEqual([`Windsurf`, t(`sandbox.connectFlow.tripDevinToken`)]);
        expect(connectTripNote(`devin`, { redirect: true })?.signs.map((sign) => sign.shows)).toEqual([`Windsurf`]);
        expect(wordsOf(connectTripNote(`devin`, { redirect: true }))).toContain(`Windsurf`);
        expect(connectTripNote(`devin`, { redirect: true })?.offerElsewhere).toBe(false);
    });

    it(`has nothing to add for a provider whose pages carry its own name`, () => {
        expect(connectTripNote(`claude`, { redirect: false })).toBeUndefined();
    });
});
