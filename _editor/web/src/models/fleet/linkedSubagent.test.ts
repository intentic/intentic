import { linkedConversationHref } from "./linkedSubagent";

// A task handed to a linked sandbox opens where it runs: the far conversation, on the far sandbox, through the router's
// own `?sandbox=` arrival. While it waits for that sandbox's owner, it opens where the owner lets it start. A row that is
// not one, or whose sandbox this editor cannot name, has no such address.

const linked = { link: `ops`, sandbox: `ops`, sandboxId: `sbx 1`, conversationId: `link-brave-otter-1` };

describe(`linkedConversationHref`, () => {
    it(`names the far sandbox and the conversation the task opened there`, () => {
        expect(linkedConversationHref({ kind: `linked`, status: `running`, linked })).toBe(`/?sandbox=sbx+1&conversation=link-brave-otter-1`);
        expect(linkedConversationHref({ kind: `linked`, status: `completed`, linked })).toBe(`/?sandbox=sbx+1&conversation=link-brave-otter-1`);
    });

    // 2026-10-15: a task waited on the far sandbox's Access page, and nothing on its row here said where.
    it(`opens the far sandbox's Linked sandboxes section while the task waits for its owner's yes`, () => {
        expect(linkedConversationHref({ kind: `linked`, status: `pending`, linked })).toBe(`/sandbox/access?sandbox=sbx+1#linked-sandboxes`);
    });

    it(`has no address for a spawned or in-process row, or for a link card that never learned its sandbox's id`, () => {
        expect(linkedConversationHref({ kind: `spawned`, status: `pending`, linked: undefined })).toBeUndefined();
        expect(linkedConversationHref({ kind: `subagent`, status: `running`, linked: undefined })).toBeUndefined();
        expect(
            linkedConversationHref({ kind: `linked`, status: `pending`, linked: { link: `ops`, sandbox: `ops`, conversationId: `link-x` } }),
        ).toBeUndefined();
    });
});
