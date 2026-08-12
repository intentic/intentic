import type { RestoredMessage } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { REDACTED, shareTranscript } from "./share-payload.js";

/* WHAT LEAVES THE MACHINE — the only tests in this feature that are about safety rather than behaviour, and
 * the reason share-payload.ts is a pure function over plain values: every claim the share dialog makes to the
 * person about to publish a conversation is checked here, against the payload itself. */

const conversation: RestoredMessage[] = [
    {
        role: "user",
        text: "here is the key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
        sentAt: 1786372320000,
        attachments: [".intentic/artifacts/attachments/a1/screenshot.png"],
        notes: [{ title: "Workspace context", text: "the branch moved under you" }],
        checkpointId: "snap-1",
    },
    {
        role: "assistant",
        text: "Fixed.",
        thinking: "the guard re-runs on every hop",
        tools: [
            {
                id: "t1",
                name: "Edit",
                category: "edit",
                status: "completed",
                target: "auth/guard.ts",
                content: [
                    { type: "diff", path: "auth/guard.ts", oldText: "const KEY = 'AKIAIOSFODNN7EXAMPLE'", newText: "const KEY = process.env.KEY" },
                    { type: "image", path: ".intentic/artifacts/browser/after.png" },
                ],
            },
        ],
    },
];

describe("a messages-only share", () => {
    it("carries the two speakers' words and none of the agent's work", () => {
        const { messages } = shareTranscript(conversation, "messages");
        expect(messages).toHaveLength(2);
        expect(messages[1]?.text).toBe("Fixed.");
        // The three things that ARE the agent's work, none of which may appear.
        expect(messages[1]?.tools).toBeUndefined();
        expect(messages[1]?.thinking).toBeUndefined();
        expect(JSON.stringify(messages)).not.toContain("auth/guard.ts");
    });

    /* An attached screenshot is part of the PROMPT, not part of the agent's work — leaving it out would cut
     * the user's own message in half, so it rides both levels. */
    it("keeps what the user attached to their own message", () => {
        const { messages, pictures } = shareTranscript(conversation, "messages");
        expect(messages[0]?.attachments).toEqual(["files/1-screenshot.png"]);
        expect(pictures).toEqual([{ source: ".intentic/artifacts/attachments/a1/screenshot.png", published: "files/1-screenshot.png" }]);
    });
});

describe("an everything share", () => {
    it("carries the work: the thinking, the cards, and the diffs of what was edited", () => {
        const { messages } = shareTranscript(conversation, "everything");
        expect(messages[1]?.thinking).toBe("the guard re-runs on every hop");
        expect(messages[1]?.tools?.[0]?.target).toBe("auth/guard.ts");
        expect(messages[1]?.tools?.[0]?.content?.[0]).toMatchObject({ type: "diff", newText: "const KEY = process.env.KEY" });
    });

    it("repoints every picture at the copy that will sit beside the page, so nothing addresses the workspace", () => {
        const { messages, pictures } = shareTranscript(conversation, "everything");
        expect(messages[1]?.tools?.[0]?.content?.[1]).toEqual({ type: "image", path: "files/2-after.png" });
        expect(pictures.map((picture) => picture.published)).toEqual(["files/1-screenshot.png", "files/2-after.png"]);
        // The one claim that matters: no workspace path survives anywhere in what gets published.
        expect(JSON.stringify(messages)).not.toContain(".intentic/");
    });
});

describe("both levels", () => {
    /* A conversation is where credentials get pasted — into a prompt, into a diff, into a command's output.
     * The outbox would REFUSE a file containing one (public-files.ts rule 5); a page that was refused reads to
     * its owner as a broken feature, so a share is rewritten to the same rule instead of being blocked by it. */
    it.each(["messages", "everything"] as const)("strips a self-identifying secret from a %s share", (detail) => {
        const published = JSON.stringify(shareTranscript(conversation, detail).messages);
        expect(published).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345");
        expect(published).toContain(REDACTED);
    });

    it("strips one out of the agent's work too, where a key is most likely to have been read out of a file", () => {
        const published = JSON.stringify(shareTranscript(conversation, "everything").messages);
        expect(published).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    // Both are the daemon's own bookkeeping: one addresses this machine's rewind state, the other is text the
    // published page has no surface for. Neither means anything to a recipient.
    it.each(["messages", "everything"] as const)("drops the daemon's own bookkeeping from a %s share", (detail) => {
        const [first] = shareTranscript(conversation, detail).messages;
        expect(first?.checkpointId).toBeUndefined();
        expect(first?.notes).toBeUndefined();
    });

    // A picture is only a picture if the page can draw it; anything else named in an image entry is not
    // copied out of the workspace, which is what stops an image entry being a way to publish a file.
    it("publishes nothing that is not an image, however a tool labelled it", () => {
        const { messages, pictures } = shareTranscript(
            [
                {
                    role: "assistant",
                    text: "",
                    tools: [{ id: "t", name: "Read", category: "read", status: "completed", content: [{ type: "image", path: ".env" }] }],
                },
            ],
            "everything",
        );
        expect(pictures).toEqual([]);
        expect(messages[0]?.tools?.[0]?.content).toEqual([]);
    });

    // Two files can share a basename; a share that quietly showed the wrong one would be worse than one that
    // showed none.
    it("keeps two pictures of the same name apart", () => {
        const { pictures } = shareTranscript(
            [
                {
                    role: "assistant",
                    text: "",
                    tools: [
                        {
                            id: "t",
                            name: "Read",
                            category: "read",
                            status: "completed",
                            content: [
                                { type: "image", path: "a/shot.png" },
                                { type: "image", path: "b/shot.png" },
                                { type: "image", path: "a/shot.png" },
                            ],
                        },
                    ],
                },
            ],
            "everything",
        );
        // Three references, two distinct files, one copy each.
        expect(pictures.map((picture) => picture.published)).toEqual(["files/1-shot.png", "files/2-shot.png"]);
    });
});
