import { conversationRedirect } from "./conversationLink";

// The regression this file exists for: the daemon has always linked notifications to `/?conversation=<id>`, and
// nothing on the web side read it, so a tap on "Question for you" landed on the board with nothing open.
describe(`conversationRedirect`, () => {
    it(`opens the agent route on a phone, where a conversation is its own screen`, () => {
        expect(conversationRedirect({ conversation: `cnv_1` }, `phone`)).toEqual({ path: `/agents/cnv_1`, query: {} });
    });

    it(`hands the desktop board the focus it already knows how to open in the dock`, () => {
        expect(conversationRedirect({ conversation: `cnv_1` }, `board`)).toEqual({ path: `/agents`, query: { focus: `cnv_1` } });
    });

    // The chat homed on the rail is parked behind its tile on the board: the link would land one press short of the chat.
    it(`opens the full-window chat for a reader whose chat lives on the rail`, () => {
        expect(conversationRedirect({ conversation: `cnv_1` }, `chat`)).toEqual({ path: `/chat`, query: { focus: `cnv_1` } });
    });

    it(`escapes an id in the phone's path segment`, () => {
        expect(conversationRedirect({ conversation: `a/b` }, `phone`)).toEqual({ path: `/agents/a%2Fb`, query: {} });
    });

    it(`leaves the home redirect alone when no conversation is named`, () => {
        expect(conversationRedirect({}, `phone`)).toBeUndefined();
        expect(conversationRedirect({ conversation: `` }, `board`)).toBeUndefined();
        expect(conversationRedirect({ conversation: [`a`] }, `chat`)).toBeUndefined();
    });
});
