import { describe, expect, it } from "vitest";
import { conversationRedirect } from "./conversationLink";

// The regression this file exists for: the daemon has always linked notifications to `/?conversation=<id>`, and
// nothing on the web side read it, so a tap on "Question for you" landed on the board with nothing open.
describe(`conversationRedirect`, () => {
    it(`opens the agent route on a phone, where a conversation is its own screen`, () => {
        expect(conversationRedirect({ conversation: `cnv_1` }, true)).toEqual({ path: `/agents/cnv_1`, query: {} });
    });

    it(`hands the desktop board the focus it already knows how to open in the dock`, () => {
        expect(conversationRedirect({ conversation: `cnv_1` }, false)).toEqual({ path: `/agents`, query: { focus: `cnv_1` } });
    });

    it(`escapes an id in the phone's path segment`, () => {
        expect(conversationRedirect({ conversation: `a/b` }, true)).toEqual({ path: `/agents/a%2Fb`, query: {} });
    });

    it(`leaves the home redirect alone when no conversation is named`, () => {
        expect(conversationRedirect({}, true)).toBeUndefined();
        expect(conversationRedirect({ conversation: `` }, false)).toBeUndefined();
        expect(conversationRedirect({ conversation: [`a`] }, false)).toBeUndefined();
    });
});
