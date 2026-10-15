import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_GROUP_DIR } from "@intentic/sandbox-contract/workspace-state";
import { loadAction } from "./actions.js";
import { type Output, parse, runCommand } from "./commands.js";
import { Graph } from "./graph.js";
import { account, headersOf, httpQueue, type MockAnswer } from "./testing.js";

let root = "";
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "m365-commands-"));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const run = async (words: string[], answers: MockAnswer[], access = "write") => {
    const mock = httpQueue(answers);
    const output = await runCommand(new Graph({ ...account, access }, async () => "token", mock.http), root, parse(words));
    return { output, calls: mock.calls };
};

const approvalOf = async (output: Output): Promise<{ id: string; item: Record<string, string> }> => {
    // SAFETY: called only on commands the test expects to hold; a non-held output fails the read below.
    const id = (output as { approvalId: string }).approvalId;
    return { id, item: JSON.parse(await readFile(join(root, STATE_GROUP_DIR.config, "approvals", `${id}.json`), "utf8")) };
};

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

test("mail read asks for the text body and saves the attachments into the workspace", async () => {
    const { output, calls } = await run(
        ["mail", "read", "msg/1", "--attachments", "mail/wniosek"],
        [
            { body: { id: "msg/1", subject: "Wniosek" } },
            {
                body: {
                    value: [
                        {
                            id: "att",
                            name: "wniosek.pdf",
                            contentBytes: Buffer.from("%PDF").toString("base64"),
                            "@odata.type": "#microsoft.graph.fileAttachment",
                        },
                    ],
                },
            },
        ],
    );
    expect(new URL(calls[0]!.url).pathname).toBe("/v1.0/me/messages/msg%2F1");
    expect(headersOf(calls[0]).get("prefer")).toBe('outlook.body-content-type="text"');
    // SAFETY: `mail read` answers { message, savedAttachments }.
    const saved = (output as { savedAttachments: string[] }).savedAttachments;
    expect(saved).toHaveLength(1);
    expect(await readFile(saved[0]!, "utf8")).toBe("%PDF");
    expect(await readdir(join(root, "mail/wniosek"))).toHaveLength(1);
});

test("mail send with workspace attachments is frozen for approval, with the owner shown recipients, text and files", async () => {
    await writeFile(
        join(root, "message.json"),
        JSON.stringify({
            subject: "Odpowiedź na wniosek",
            body: { contentType: "Text", content: "Przesyłamy odpowiedź." },
            toRecipients: [{ emailAddress: { address: "wnioskodawca@example.org" } }],
        }),
    );
    await mkdir(join(root, "pisma"));
    await writeFile(join(root, "pisma/odpowiedz.pdf"), "%PDF-1.7 odpowiedź");
    const { output, calls } = await run(["mail", "send", "--file", "message.json", "--attach", "pisma/odpowiedz.pdf"], []);
    expect(calls).toEqual([]);
    const { id, item } = await approvalOf(output);
    expect(item["summary"]).toBe('Send "Odpowiedź na wniosek" — to wnioskodawca@example.org');
    expect(item["details"]).toContain("Przesyłamy odpowiedź.");
    expect(item["details"]).toContain("Attachments: odpowiedz.pdf (1 KB)");
    const frozen = await loadAction(root, id);
    expect(frozen.path).toBe("/me/sendMail");
    // SAFETY: `mail send` freezes { message, saveToSentItems }, the sendMail request.
    const attachment = (frozen.body as { message: { attachments: { name: string; contentBytes: string }[] } }).message.attachments[0]!;
    expect(attachment.name).toBe("odpowiedz.pdf");
    expect(Buffer.from(attachment.contentBytes, "base64").toString()).toBe("%PDF-1.7 odpowiedź");
});

test("a reply shows the owner what it answers, and read only refuses it before Graph is asked anything", async () => {
    await writeFile(join(root, "reply.json"), JSON.stringify({ comment: "Dziękujemy, sprawa w toku." }));
    const { output, calls } = await run(
        ["mail", "reply-all", "m1", "--file", "reply.json"],
        [
            {
                body: {
                    subject: "Pytanie",
                    from: { emailAddress: { address: "mieszkaniec@example.org" } },
                    ccRecipients: [{ emailAddress: { address: "radny@example.org" } }],
                },
            },
        ],
    );
    expect(calls).toHaveLength(1);
    const { item, id } = await approvalOf(output);
    expect(item["summary"]).toContain('Reply to everyone on "Pytanie"');
    expect(item["details"]).toContain("radny@example.org");
    expect((await loadAction(root, id)).path).toBe("/me/messages/m1/replyAll");
    await writeFile(join(root, "message.json"), JSON.stringify({ subject: "x" }));
    await expect(run(["mail", "send", "--file", "message.json"], [], "read")).rejects.toThrow("read-only");
});

test("a forward's own message keeps its recipients and body when workspace files are attached, and the owner sees both", async () => {
    await writeFile(
        join(root, "forward.json"),
        JSON.stringify({
            message: {
                toRecipients: [{ emailAddress: { address: "sekretariat@urzad.example.org" } }],
                body: { contentType: "Text", content: "Przekazuję pismo do rejestracji." },
            },
        }),
    );
    await writeFile(join(root, "skan.pdf"), "%PDF-1.7 skan");
    const { output } = await run(
        ["mail", "forward", "m2", "--file", "forward.json", "--attach", "skan.pdf"],
        [{ body: { subject: "Wniosek", from: { emailAddress: { address: "mieszkaniec@example.org" } } } }],
    );
    const { id, item } = await approvalOf(output);
    expect(item["summary"]).toBe('Forward "Wniosek" — to sekretariat@urzad.example.org');
    expect(item["details"]).toContain("Przekazuję pismo do rejestracji.");
    // SAFETY: `mail forward` freezes the request file with the attachments joined into its `message`.
    const frozen = (await loadAction(root, id)).body as {
        message: { toRecipients: unknown[]; body: { content: string }; attachments: { name: string }[] };
    };
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

test("cancelling a meeting holds and names who would get the cancellation", async () => {
    await writeFile(join(root, "cancel.json"), JSON.stringify({ comment: "Narada została odwołana." }));
    const { output } = await run(
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
    );
    const { item } = await approvalOf(output);
    expect(item["summary"]).toBe('Cancel "Narada wydziału", 2026-10-14T09:00:00 – 2026-10-14T09:30:00');
    expect(item["details"]).toContain("kierownik@example.org");
});

test("an upload freezes the file's bytes, and running the approval sends exactly those bytes", async () => {
    await writeFile(join(root, "protokol.docx"), "protocol v1");
    const proposed = await run(
        ["files", "upload", "--file", "protokol.docx", "--name", "protokol.docx", "--drive", "lib/1", "--parent", "folder"],
        [],
    );
    const { id, item } = await approvalOf(proposed.output);
    await writeFile(join(root, "protokol.docx"), "edited after proposing");
    await writeFile(join(root, STATE_GROUP_DIR.config, "approvals", `${id}.json`), JSON.stringify({ ...item, status: "running" }));
    const sent = await run(["action", "run", id], [{ body: { id: "uploaded" } }]);
    expect(sent.output).toEqual({ held: false, result: { id: "uploaded" } });
    const call = sent.calls[0]!;
    expect(new URL(call.url).pathname).toBe("/v1.0/drives/lib%2F1/items/folder:/protokol.docx:/content");
    expect(call.init?.method).toBe("PUT");
    expect(headersOf(call).get("content-type")).toBe("application/octet-stream");
    // SAFETY: an upload's body is the frozen bytes (graph.ts sends `bytes` as they are).
    expect(Buffer.from(call.init?.body as Uint8Array).toString()).toBe("protocol v1");
    await expect(run(["files", "upload", "--file", "protokol.docx", "--name", "../x"], [])).rejects.toThrow("without folders");
});

test("file search and listing stay within the limit and encode the query for OData", async () => {
    const { calls } = await run(["files", "search", "--query", "regulamin o'connor", "--limit", "5"], [{ body: { value: [] } }]);
    expect(calls[0]!.url).toContain("/v1.0/me/drive/root/search(q='regulamin%20o%27%27connor')");
    expect(new URL(calls[0]!.url).searchParams.get("$top")).toBe("5");
});
