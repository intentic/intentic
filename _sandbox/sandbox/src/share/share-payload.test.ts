import type { TranscriptRow } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { REDACTED, shareTranscript } from "./share-payload.js";

// Pins what leaves the machine: the safety tests for a pure function whose payload is checked directly, since every
// claim the share dialog makes to a publisher is verified here.

const conversation: TranscriptRow[] = [
    {
        role: "user",
        text: "here is the key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
        sentAt: 1786372320000,
        attachments: [".intentic/records/artifacts/attachments/a1/screenshot.png"],
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
                    { type: "image", path: ".intentic/records/artifacts/browser/after.png" },
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
        expect(messages[1]?.tools).toBeUndefined();
        expect(messages[1]?.thinking).toBeUndefined();
        expect(JSON.stringify(messages)).not.toContain("auth/guard.ts");
    });

    // An attachment belongs to the prompt, not the agent's work, so it survives at every detail level.
    it("keeps what the user attached to their own message", () => {
        const { messages, pictures } = shareTranscript(conversation, "messages");
        expect(messages[0]?.attachments).toEqual(["files/1-screenshot.png"]);
        expect(pictures).toEqual([{ source: ".intentic/records/artifacts/attachments/a1/screenshot.png", published: "files/1-screenshot.png" }]);
    });
});

// `placed`: an owner-written line in the agent's voice must not read as the agent's to a human reader of the share page
// (the agent-facing handoff stays blind to it; see TranscriptRowSchema).
describe("a placed row", () => {
    it("keeps its mark in the shared payload", () => {
        const placed: TranscriptRow[] = [{ role: "assistant", text: "I verified it myself.", placed: true }];
        expect(shareTranscript(placed, "messages").messages[0]).toEqual({ role: "assistant", text: "I verified it myself.", placed: true });
        expect(shareTranscript(placed, "everything").messages[0]).toEqual({ role: "assistant", text: "I verified it myself.", placed: true });
    });
});

describe("an everything share", () => {
    it("carries the work: the thinking, the cards, and the diffs of what was edited", () => {
        const { messages } = shareTranscript(conversation, "everything");
        expect(messages[1]?.thinking).toBe(conversation[1]?.thinking);
        expect(messages[1]?.tools?.[0]?.target).toBe("auth/guard.ts");
        expect(messages[1]?.tools?.[0]?.content?.[0]).toMatchObject({ type: "diff", newText: "const KEY = process.env.KEY" });
    });

    it("repoints every picture at the copy that will sit beside the page, so nothing addresses the workspace", () => {
        const { messages, pictures } = shareTranscript(conversation, "everything");
        expect(messages[1]?.tools?.[0]?.content?.[1]).toEqual({ type: "image", path: "files/2-after.png" });
        expect(pictures.map((picture) => picture.published)).toEqual(["files/1-screenshot.png", "files/2-after.png"]);
        expect(JSON.stringify(messages)).not.toContain(".intentic/");
    });

    it("carries and redacts the task checklist in everything mode", () => {
        const withTodos: TranscriptRow[] = [
            {
                role: "assistant",
                text: "Working",
                todos: [
                    { content: "check sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345", status: "completed" },
                    { content: "deploy", status: "in_progress", activeForm: "Deploying sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345" },
                ],
            },
        ];
        const { messages: msgsOnly } = shareTranscript(withTodos, "messages");
        expect(msgsOnly[0]?.todos).toBeUndefined();
        const { messages: everything } = shareTranscript(withTodos, "everything");
        expect(everything[0]?.todos).toEqual([
            { content: `check ${REDACTED}`, status: "completed" },
            { content: "deploy", status: "in_progress", activeForm: `Deploying ${REDACTED}` },
        ]);
    });
});

describe("both levels", () => {
    // The outbox refuses a file containing a credential (public-files.ts rule 5); a share rewrites to that same rule
    // instead of being blocked by it.
    it.each(["messages", "everything"] as const)("strips a self-identifying secret from a %s share", (detail) => {
        const published = JSON.stringify(shareTranscript(conversation, detail).messages);
        expect(published).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345");
        expect(published).toContain(REDACTED);
    });

    it("strips one out of the agent's work too, where a key is most likely to have been read out of a file", () => {
        const published = JSON.stringify(shareTranscript(conversation, "everything").messages);
        expect(published).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    // `checkpointId` addresses this machine's rewind state; `notes` has no surface on the published page. Neither means
    // anything to a recipient.
    it.each(["messages", "everything"] as const)("drops the daemon's own bookkeeping from a %s share", (detail) => {
        const [first] = shareTranscript(conversation, detail).messages;
        expect(first?.checkpointId).toBeUndefined();
        expect(first?.notes).toBeUndefined();
    });

    // An image entry only ever copies an actual image; nothing else it names leaves the workspace.
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

    // A silently wrong picture is worse than a missing one.
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
        expect(pictures.map((picture) => picture.published)).toEqual(["files/1-shot.png", "files/2-shot.png"]);
    });
});
