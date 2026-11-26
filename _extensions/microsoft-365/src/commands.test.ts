import { createHash } from "node:crypto";
import type { Action, ActionDraft, ActionOutcome } from "./actions.js";
import { actionFor } from "./actions.js";
import { LEGACY_ACTION_RUN, parse, runCommand, validateArguments } from "./commands.js";
import { Graph } from "./graph.js";
import { account, headersOf, httpQueue, type MockAnswer, memoryIo } from "./testing.js";

// The commands as the backend runs them: the files the CLI sent in memory, every outward action handed to `act` (the
// owner's rules are the daemon's, actions.ts), and Graph mocked.

const run = async (words: string[], answers: MockAnswer[], options: { readonly sent?: Record<string, string> } = {}) => {
    const mock = httpQueue(answers);
    const graph = new Graph(account, async () => "token", mock.http);
    const acted: Action[] = [];
    const act = async (draft: ActionDraft): Promise<ActionOutcome> => {
        acted.push(actionFor(graph.account, draft));
        return { held: true, approvalId: "microsoft365-held" };
    };
    const io = memoryIo(options.sent);
    const output = await runCommand(graph, io.io, parse(words), act);
    return { output, calls: mock.calls, acted, saved: io.files, downloads: io.downloads };
};

test("a flag no command reads, a missing id or a stray word is refused before anything is sent", () => {
    expect(() => parse(["mail", "list", "--unknown", "x"])).toThrow("Unknown");
    expect(() => parse(["mail", "list", "--limit"])).toThrow("empty flag");
    expect(() => parse(["mail", "list", "--limit", "5", "--limit", "6"])).toThrow("repeated");
    expect(() => validateArguments(parse(["mail", "list", "--file", "ignored.json"]))).toThrow("not an option of `m365 mail list`");
    expect(() => validateArguments(parse(["whoami", "extra"]))).toThrow("takes no further words");
    expect(() => validateArguments(parse(["mail", "read"]))).toThrow("takes one id");
    expect(() => validateArguments(parse(["mail", "explode"]))).toThrow("m365 [--account");
    expect(() => validateArguments(parse(["--account", "office", "mail", "reply-all", "id", "--file", "r.json"]))).not.toThrow();
});

test("mail list asks for the newest first, a page no bigger than the limit, and only the fields worth reading", async () => {
    const { output, calls } = await run(
        ["mail", "list", "--limit", "2"],
        [{ body: { value: [{ id: "a" }, { id: "b" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next" } }],
    );
    expect(output).toEqual([{ id: "a" }, { id: "b" }]);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1.0/me/mailFolders/inbox/messages");
    expect(url.searchParams.get("$top")).toBe("2");
    expect(url.searchParams.get("$orderby")).toBe("receivedDateTime desc");
    expect(url.searchParams.get("$select")).toContain("bodyPreview");
    const filtered = await run(["mail", "list", "--filter", "isRead eq false"], [{ body: { value: [] } }]);
    expect(new URL(filtered.calls[0]!.url).searchParams.get("$orderby")).toBeNull();
    await expect(run(["mail", "list", "--limit", "0"], [])).rejects.toThrow("--limit");
});

test("mail search covers every folder unless one is named, and quotes the words for Graph", async () => {
    const { calls } = await run(["mail", "search", "--query", "wniosek o informację"], [{ body: { value: [] } }]);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1.0/me/messages");
    expect(url.searchParams.get("$search")).toBe('"wniosek o informację"');
});

test("mail read asks for the text body and hands the attachments back for the CLI to save", async () => {
    const { output, calls, saved } = await run(
        ["mail", "read", "msg/1", "--attachments", "mail/wniosek"],
        [
            { body: { id: "msg/1", subject: "Wniosek" } },
            { body: { value: [{ id: "att", name: "wniosek.pdf", contentBytes: Buffer.from("%PDF").toString("base64"), "@odata.type": "#microsoft.graph.fileAttachment" }] } },
        ],
    );
    expect(new URL(calls[0]!.url).pathname).toBe("/v1.0/me/messages/msg%2F1");
    expect(headersOf(calls[0]).get("prefer")).toBe('outlook.body-content-type="text"');
    // Two attachments may share a name, so each is saved under a prefix of its id's hash.
    const path = `mail/wniosek/${createHash("sha256").update("att").digest("hex").slice(0, 20)}-wniosek.pdf`;
    expect(saved).toEqual([{ path, data: Buffer.from("%PDF").toString("base64") }]);
    // SAFETY: `mail read` answers { message, savedAttachments }.
    expect((output as { savedAttachments: string[] }).savedAttachments).toEqual([path]);
});

test("mail send with attachments the CLI sent is one action, with the owner shown recipients, text and files", async () => {
    const message = {
        subject: "Odpowiedź na wniosek",
        body: { contentType: "Text", content: "Przesyłamy odpowiedź." },
        toRecipients: [{ emailAddress: { address: "wnioskodawca@example.org" } }],
    };
    const { output, calls, acted } = await run(["mail", "send", "--file", "message.json", "--attach", "pisma/odpowiedz.pdf"], [], {
        sent: { "message.json": JSON.stringify(message), "pisma/odpowiedz.pdf": "%PDF-1.7 odpowiedź" },
    });
    expect(calls).toEqual([]);
    expect(output).toEqual({ held: true, approvalId: "microsoft365-held" });
    const action = acted[0]!;
    expect(action).toMatchObject({ key: "microsoft365.mail.send", path: "/me/sendMail", method: "POST", account: "office", channel: "wnioskodawca@example.org" });
    expect(action.summary).toBe('Send "Odpowiedź na wniosek" — to wnioskodawca@example.org');
    expect(action.details).toContain("Przesyłamy odpowiedź.");
    expect(action.details).toContain("Attachments: odpowiedz.pdf (1 KB)");
    // SAFETY: `mail send` freezes { message, saveToSentItems }, the sendMail request.
    const attachment = (action.body as { message: { attachments: { name: string; contentBytes: string }[] } }).message.attachments[0]!;
    expect(attachment.name).toBe("odpowiedz.pdf");
    expect(Buffer.from(attachment.contentBytes, "base64").toString()).toBe("%PDF-1.7 odpowiedź");
    await expect(run(["mail", "send", "--file", "missing.json"], [])).rejects.toThrow("did not send missing.json");
});

test("a reply shows the owner what it answers", async () => {
    const { acted, calls } = await run(
        ["mail", "reply-all", "m1", "--file", "reply.json"],
        [{ body: { subject: "Pytanie", from: { emailAddress: { address: "mieszkaniec@example.org" } }, ccRecipients: [{ emailAddress: { address: "radny@example.org" } }] } }],
        { sent: { "reply.json": JSON.stringify({ comment: "Dziękujemy, sprawa w toku." }) } },
    );
    expect(calls).toHaveLength(1);
    expect(acted[0]?.summary).toContain('Reply to everyone on "Pytanie"');
    expect(acted[0]?.details).toContain("radny@example.org");
    expect(acted[0]?.path).toBe("/me/messages/m1/replyAll");
});

test("a forward's own message keeps its recipients and body when files are attached, and the owner sees both", async () => {
    const { acted } = await run(
        ["mail", "forward", "m2", "--file", "forward.json", "--attach", "skan.pdf"],
        [{ body: { subject: "Wniosek", from: { emailAddress: { address: "mieszkaniec@example.org" } } } }],
        {
            sent: {
                "forward.json": JSON.stringify({
                    message: {
                        toRecipients: [{ emailAddress: { address: "sekretariat@urzad.example.org" } }],
                        body: { contentType: "Text", content: "Przekazuję pismo do rejestracji." },
                    },
                }),
                "skan.pdf": "%PDF-1.7 skan",
            },
        },
    );
    expect(acted[0]?.summary).toBe('Forward "Wniosek" — to sekretariat@urzad.example.org');
    expect(acted[0]?.details).toContain("Przekazuję pismo do rejestracji.");
    // SAFETY: `mail forward` freezes the request file with the attachments joined into its `message`.
    const frozen = acted[0]?.body as { message: { toRecipients: unknown[]; body: { content: string }; attachments: { name: string }[] } };
    expect(frozen.message.toRecipients).toHaveLength(1);
    expect(frozen.message.body.content).toBe("Przekazuję pismo do rejestracji.");
    expect(frozen.message.attachments.map((attachment) => attachment.name)).toEqual(["skan.pdf"]);
});

test("calendar events ask Graph for the office's own time zone and refuse one that is not a zone", async () => {
    const { calls } = await run(
        ["calendar", "events", "--from", "2026-10-13T00:00:00+02:00", "--to", "2026-10-14T00:00:00+02:00", "--tz", "Europe/Warsaw"],
        [{ body: { value: [{ id: "event" }] } }],
    );
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1.0/me/calendarView");
    expect(url.searchParams.get("startDateTime")).toBe("2026-10-13T00:00:00+02:00");
    expect(headersOf(calls[0]).get("prefer")).toBe('outlook.timezone="Europe/Warsaw"');
    await expect(run(["calendar", "read", "e", "--tz", 'Warsaw"; x'], [])).rejects.toThrow("IANA");
});

test("cancelling a meeting is one action naming who would get the cancellation", async () => {
    const { acted } = await run(
        ["calendar", "cancel", "e1", "--file", "cancel.json"],
        [
            {
                body: {
                    subject: "Narada wydziału",
                    start: { dateTime: "2026-10-14T09:00:00" },
                    end: { dateTime: "2026-10-14T09:30:00" },
                    attendees: [{ emailAddress: { address: "kierownik@example.org" } }],
                },
            },
        ],
        { sent: { "cancel.json": JSON.stringify({ comment: "Narada została odwołana." }) } },
    );
    expect(acted[0]).toMatchObject({ key: "microsoft365.calendar.write", channel: "kierownik@example.org" });
    expect(acted[0]?.summary).toBe('Cancel "Narada wydziału", 2026-10-14T09:00:00 – 2026-10-14T09:30:00');
    expect(acted[0]?.details).toContain("kierownik@example.org");
});

test("an upload freezes the bytes the CLI sent, and refuses a name with folders in it", async () => {
    const { acted } = await run(["files", "upload", "--file", "protokol.docx", "--name", "protokol.docx", "--drive", "lib/1", "--parent", "folder"], [], {
        sent: { "protokol.docx": "protocol v1" },
    });
    expect(acted[0]).toMatchObject({ key: "microsoft365.files.upload", path: "/drives/lib%2F1/items/folder:/protokol.docx:/content", method: "PUT", binary: true });
    expect(Buffer.from(String(acted[0]?.body), "base64").toString()).toBe("protocol v1");
    await expect(run(["files", "upload", "--file", "protokol.docx", "--name", "../x"], [], { sent: { "protokol.docx": "x" } })).rejects.toThrow("without folders");
});

test("a download hands back Microsoft's storage address for the CLI to fetch, and refuses any other host", async () => {
    const { output, downloads } = await run(
        ["files", "download", "item", "--out", "files/report.docx"],
        [{ body: { "@microsoft.graph.downloadUrl": "https://office.sharepoint.com/download?ticket=opaque" } }],
    );
    expect(downloads).toEqual([{ path: "files/report.docx", url: "https://office.sharepoint.com/download?ticket=opaque" }]);
    expect(output).toEqual({ saved: "files/report.docx" });
    await expect(run(["files", "download", "item", "--out", "x"], [{ body: { "@microsoft.graph.downloadUrl": "https://evil.example/file" } }])).rejects.toThrow("Unsupported");
});

test("file search and listing stay within the limit and encode the query for OData", async () => {
    const { calls } = await run(["files", "search", "--query", "regulamin o'connor", "--limit", "5"], [{ body: { value: [] } }]);
    expect(calls[0]!.url).toContain("/v1.0/me/drive/root/search(q='regulamin%20o%27%27connor')");
    expect(new URL(calls[0]!.url).searchParams.get("$top")).toBe("5");
});

test("an approval the older CLI drafted is not run: the command is proposed again", async () => {
    await expect(run(["action", "run", "m365-1234"], [])).rejects.toThrow(LEGACY_ACTION_RUN);
});
