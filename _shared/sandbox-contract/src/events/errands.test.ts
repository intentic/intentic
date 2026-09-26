import { errandOfPrompt, errandOfRow } from "./errands.js";
import { landBreakagePrompt, landFixPrompt } from "./land-breakage.js";
import { LAND_CONFLICT_OPENING } from "./land-conflict.js";
import { verifyNudgePrompt } from "./verify-nudge.js";

// A row says what it is for since rows carry `errand`; one written before is still read by its opening.

describe(`which errand a message is`, () => {
    test(`is what the row says it is, whatever its words`, () => {
        expect(errandOfRow({ role: `user`, text: `Carry on from where you left off.`, errand: `land-fix-nudge` })).toBe(`land-fix-nudge`);
    });

    test(`is read by its opening on a row written before rows said, and on nothing but a message`, () => {
        expect(errandOfPrompt(landBreakagePrompt([`- a failure`]))).toBe(`land-breakage`);
        expect(errandOfPrompt(landFixPrompt([`- a failure`]))).toBe(`land-fix`);
        expect(errandOfPrompt(verifyNudgePrompt([`x`]))).toBe(`verify-nudge`);
        expect(errandOfPrompt(`${LAND_CONFLICT_OPENING}\n\nthe files`)).toBe(`land-conflict`);
        expect(errandOfPrompt(`Please fix the parser`)).toBeUndefined();
        expect(errandOfRow({ role: `assistant`, text: landFixPrompt([]) })).toBeUndefined();
        expect(errandOfRow({ role: `user`, text: `hello` })).toBeUndefined();
    });
});
