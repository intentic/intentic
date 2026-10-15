import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadFile, saveAttachments, saveBytes, workspaceFile } from "./files.js";
import { Graph } from "./graph.js";
import { account, httpQueue } from "./testing.js";

test("attachments save decoded bytes inside workspace, flatten hostile names and refuse overwrites", async () => {
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
        const files = await saveAttachments(new Graph(account, async () => "token", http), root, "msg", "mail");
        expect(files).toEqual([join(root, "mail/ca978112ca1bbdcafac2-wniosek.docx"), join(root, "mail/3e23e8160039594a3389-attached-message")]);
        expect(await readFile(files[0]!, "utf8")).toBe("office document");
        expect(await readFile(files[1]!, "utf8")).toBe("MIME mail");
        await expect(saveBytes(root, "mail/ca978112ca1bbdcafac2-wniosek.docx", Buffer.from("overwrite"))).rejects.toThrow("EEXIST");
        await expect(workspaceFile(root, "../escape", true)).rejects.toThrow("inside the workspace");
        await symlink(tmpdir(), join(root, "escape"));
        await expect(workspaceFile(root, "escape/file", true)).rejects.toThrow("leaves the workspace");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("document downloads use Microsoft storage without authorization and refuse a foreign host", async () => {
    const root = await mkdtemp(join(tmpdir(), "m365-download-"));
    try {
        const graphHttp = httpQueue([{ body: { "@microsoft.graph.downloadUrl": "https://office.sharepoint.com/download?ticket=opaque" } }]);
        const storage = httpQueue([{ bytes: Buffer.from("report bytes") }]);
        const saved = await downloadFile(
            new Graph(account, async () => "graph-secret", graphHttp.http),
            root,
            "/me/drive/items/item",
            "files/report.docx",
            storage.http,
        );
        expect(await readFile(saved, "utf8")).toBe("report bytes");
        expect(storage.calls[0]!.init?.headers).toBeUndefined();
        expect(storage.calls[0]!.init?.redirect).toBe("error");
        const bad = httpQueue([{ body: { "@microsoft.graph.downloadUrl": "https://evil.example/file" } }]);
        await expect(
            downloadFile(new Graph(account, async () => "token", bad.http), root, "/me/drive/items/item", "files/bad", storage.http),
        ).rejects.toThrow("Unsupported");
        expect(storage.calls).toHaveLength(1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
