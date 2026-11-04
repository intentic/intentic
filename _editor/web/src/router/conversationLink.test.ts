import { homePath, insidePath, page } from "@intentic/sandbox-contract/app-routes";
import { activeSandboxId } from "../app/storage/activeSandbox";
import { conversationRedirect } from "./conversationLink";

// The regression this file exists for: the daemon has always linked notifications to `/?conversation=<id>`, and
// nothing on the web side read it, so a tap on "Question for you" landed on the board with nothing open.

beforeEach(() => {
    activeSandboxId.value = `box-1`;
});

describe(`conversationRedirect`, () => {
    it(`opens the agent's page on a phone, where a conversation is its own screen, inside the sandbox open`, () => {
        expect(conversationRedirect({ conversation: `cnv_1` }, `phone`)).toBe(insidePath(`box-1`, page.agent(`cnv_1`)));
    });

    it(`hands the desktop board the focus it already knows how to open in the dock`, () => {
        expect(conversationRedirect({ conversation: `cnv_1` }, `board`)).toBe(insidePath(`box-1`, page.agents({ query: { focus: `cnv_1` } })));
    });

    // The chat homed on the rail is parked behind its tile on the board: the link would land one press short of the chat.
    it(`opens the full-window chat for a reader whose chat lives on the rail`, () => {
        expect(conversationRedirect({ conversation: `cnv_1` }, `chat`)).toBe(insidePath(`box-1`, page.chat({ query: { focus: `cnv_1` } })));
    });

    it(`escapes an id in the phone's path segment`, () => {
        expect(conversationRedirect({ conversation: `a/b` }, `phone`)).toBe(`/s/box-1/agents/a%2Fb`);
    });

    it(`opens it in the frame and sandbox of a page that names them, and inside the sandbox from Home's own page`, () => {
        const homeBoard = { meta: { frame: `home`, page: `workspace` }, params: { sandbox: `box-2` } } as const;
        expect(conversationRedirect({ conversation: `cnv_1` }, `board`, homeBoard)).toBe(
            homePath(`box-2`, page.agents({ query: { focus: `cnv_1` } })),
        );
        const homeChat = { meta: { frame: `home` }, params: { sandbox: `box-2` } } as const;
        expect(conversationRedirect({ conversation: `cnv_1` }, `phone`, homeChat)).toBe(insidePath(`box-2`, page.agent(`cnv_1`)));
    });

    it(`has nowhere but Home with no sandbox open`, () => {
        activeSandboxId.value = undefined;
        expect(conversationRedirect({ conversation: `cnv_1` }, `board`)).toBe(homePath());
    });

    it(`leaves the home redirect alone when no conversation is named`, () => {
        expect(conversationRedirect({}, `phone`)).toBeUndefined();
        expect(conversationRedirect({ conversation: `` }, `board`)).toBeUndefined();
        expect(conversationRedirect({ conversation: [`a`] }, `chat`)).toBeUndefined();
    });
});
