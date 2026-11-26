import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputsOf, saveAnswer } from "./cli-files.js";
import { parse } from "./commands.js";
import { httpQueue } from "./testing.js";

// The `m365` side of a command: it sends the backend the workspace files the command names, and saves what comes back
// where the command said, answering with the paths it saved them under.

let root = "";
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "m365-cli-"));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

test("a command's --file and every --attach go to the backend as bytes, read inside the workspace only", async () => {
    await writeFile(join(root, "message.json"), "{}");
    await mkdir(join(root, "pisma"));
    await writeFile(join(root, "pisma/a.pdf"), "%PDF a");
    const sent = await inputsOf(root, parse(["mail", "send", "--file", "message.json", "--attach", "pisma/a.pdf, message.json"]));
    expect(Object.fromEntries(Object.entries(sent).map(([path, data]) => [path, Buffer.from(data, "base64").toString()]))).toEqual({
        "message.json": "{}",
        "pisma/a.pdf": "%PDF a",
    });
    expect(await inputsOf(root, parse(["mail", "list"]))).toEqual({});
    await expect(inputsOf(root, parse(["mail", "send", "--file", "../outside.json"]))).rejects.toThrow("inside the workspace");
});

test("attachments and downloads are saved where the command said, and the output names where they landed", async () => {
    const storage = httpQueue([{ bytes: Buffer.from("report") }]);
    const output = await saveAnswer(
        root,
        {
            output: { message: { subject: "mail/x.pdf stays" }, savedAttachments: ["mail/x.pdf"], saved: "files/report.docx" },
            files: [{ path: "mail/x.pdf", data: Buffer.from("%PDF x").toString("base64") }],
            downloads: [{ path: "files/report.docx", url: "https://office.sharepoint.com/download?ticket=t" }],
        },
        storage.http,
    );
    expect(output).toEqual({
        message: { subject: "mail/x.pdf stays" },
        savedAttachments: [join(root, "mail/x.pdf")],
        saved: join(root, "files/report.docx"),
    });
    expect(await readFile(join(root, "mail/x.pdf"), "utf8")).toBe("%PDF x");
    expect(await readFile(join(root, "files/report.docx"), "utf8")).toBe("report");
    await expect(saveAnswer(root, { output: {}, files: [{ path: "mail/x.pdf", data: "" }], downloads: [] })).rejects.toThrow("EEXIST");
});
