import { linkedConversationHref } from "./linkedSubagent";

// A task handed to a linked sandbox opens where it runs: the far conversation, on the far sandbox, through the router's
// own `?sandbox=` arrival. A row that is not one, or whose sandbox this editor cannot name, has no such address.

describe(`linkedConversationHref`, () => {
    it(`names the far sandbox and the conversation the task opened there`, () => {
        expect(
            linkedConversationHref({
                kind: `linked`,
                linked: { link: `ops`, sandbox: `ops`, sandboxId: `sbx 1`, conversationId: `link-brave-otter-1` },
            }),
        ).toBe(`/?sandbox=sbx+1&conversation=link-brave-otter-1`);
    });

    it(`has no address for a spawned or in-process row, or for a link card that never learned its sandbox's id`, () => {
        expect(linkedConversationHref({ kind: `spawned`, linked: undefined })).toBeUndefined();
        expect(linkedConversationHref({ kind: `subagent`, linked: undefined })).toBeUndefined();
        expect(linkedConversationHref({ kind: `linked`, linked: { link: `ops`, sandbox: `ops`, conversationId: `link-x` } })).toBeUndefined();
    });
});
