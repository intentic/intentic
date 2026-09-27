import { pushFixConversationId } from "../../ids/conversation-ids.js";
import { pushFixBase, pushRedOf, type Red, RedSchema } from "./push-checks.js";

// What a push left is a Red like any other (source `push`, scope the project), and the hand-over's id is named by when
// that red began, so the editor and the daemon find the same attempt whichever of them asks.

const red = (over: Partial<Red>): Red => RedSchema.parse({ source: `push`, scope: `app`, since: 100, ...over });

describe(`a project's push red`, () => {
    test(`is the push red of that project, never a CI red of the same name or another project's`, () => {
        const ci = red({ source: `ci` });
        const other = red({ scope: `web` });
        const mine = red({});
        expect(pushRedOf([ci, other, mine], `app`)).toBe(mine);
        expect(pushRedOf([ci, other], `app`)).toBeUndefined();
        expect(pushRedOf(undefined, `app`)).toBeUndefined();
    });

    test(`names its hand-over by when it began, with the workspace root spelled as the workspace`, () => {
        expect(pushFixBase(red({}))).toBe(pushFixConversationId(`app`, `red:100`));
        expect(pushFixBase(red({ scope: `` }))).toBe(pushFixConversationId(`workspace`, `red:100`));
        expect(pushFixBase(undefined)).toBeUndefined();
    });

    test(`that began later is a fresh attempt`, () => {
        expect(pushFixBase(red({ since: 200 }))).toBe(pushFixConversationId(`app`, `red:200`));
    });
});
