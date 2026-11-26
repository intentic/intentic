import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchDownload, saveAttachments, saveBytes, workspaceFile } from "./files.js";
import { Graph } from "./graph.js";
import { account, httpQueue, memoryIo } from "./testing.js";

test("attachments come back decoded under flattened names, and the CLI saves them inside the workspace, never over a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "m365-files-"));
    try {
        const { http } = httpQueue([
            {
                body: {
                    value: [
                        {
                            id: "a",
                            name: "../../wniosek.docx",
                            contentBytes: Buffer.from("office document").toString("base64"),
                            "@odata.type": "#microsoft.graph.fileAttachment",
                        },
                    ],
                    "@odata.nextLink": "https://graph.microsoft.com/v1.0/attachment-page2",
                },
            },
            { body: { value: [{ id: "b", name: "attached-message", "@odata.type": "#microsoft.graph.itemAttachment" }] } },
            { bytes: Buffer.from("MIME mail") },
        ]);
        const io = memoryIo();
        const names = await saveAttachments(new Graph(account, async () => "token", http), io.io, "msg", "mail");
        expect(names).toEqual(["mail/ca978112ca1bbdcafac2-wniosek.docx", "mail/3e23e8160039594a3389-attached-message"]);
        expect(io.files.map((file) => Buffer.from(file.data, "base64").toString())).toEqual(["office document", "MIME mail"]);
        const saved = await saveBytes(root, names[0]!, Buffer.from(io.files[0]!.data, "base64"));
        expect(saved).toBe(join(root, "mail/ca978112ca1bbdcafac2-wniosek.docx"));
        expect(await readFile(saved, "utf8")).toBe("office document");
        await expect(saveBytes(root, names[0]!, Buffer.from("overwrite"))).rejects.toThrow("EEXIST");
        await expect(workspaceFile(root, "../escape", true)).rejects.toThrow("inside the workspace");
        await symlink(tmpdir(), join(root, "escape"));
        await expect(workspaceFile(root, "escape/file", true)).rejects.toThrow("leaves the workspace");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("the CLI fetches a download from Microsoft storage without authorization and refuses a foreign host", async () => {
    const root = await mkdtemp(join(tmpdir(), "m365-download-"));
    try {
        const storage = httpQueue([{ bytes: Buffer.from("report bytes") }]);
        const saved = await fetchDownload(root, "files/report.docx", "https://office.sharepoint.com/download?ticket=opaque", storage.http);
        expect(await readFile(saved, "utf8")).toBe("report bytes");
        expect(storage.calls[0]!.init?.headers).toBeUndefined();
        expect(storage.calls[0]!.init?.redirect).toBe("error");
        await expect(fetchDownload(root, "files/bad", "https://evil.example/file", storage.http)).rejects.toThrow("Unsupported");
        expect(storage.calls).toHaveLength(1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
