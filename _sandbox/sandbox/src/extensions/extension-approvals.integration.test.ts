import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import { approvedExtensions, approveExtension, extensionApprovals, forgetExtensionApproval, revokeExtensionApproval } from "./extension-approvals.js";

// The owner's yes to a workspace extension, listed where it can be taken back and undone without touching the extension.

const manifest = (name: string, extra: object = {}) =>
    ExtensionManifestSchema.parse({ publisher: "acme", name, version: "1.0.0", engines: { intentic: "^0.2.0" }, ...extra });
const historyRoot = (): string => mkdtempSync(join(tmpdir(), "extension-approvals-"));

test("approved extensions are listed newest first with the powers they were approved for", async () => {
    const history = historyRoot();
    await approveExtension(history, "acme.plain", manifest("plain"), 100);
    await approveExtension(history, "acme.backend", manifest("backend", { server: "dist/server.js" }), 200);

    expect(await approvedExtensions(history)).toEqual({
        unreadable: false,
        extensions: [
            { id: "acme.backend", powers: ["runs a backend bundle inside the daemon's extension host"], approvedAt: 200 },
            { id: "acme.plain", powers: [], approvedAt: 100 },
        ],
    });
});

test("taking one back returns it to waiting for a yes: not approved, and not remembered as approved before", async () => {
    const history = historyRoot();
    const backend = manifest("backend", { server: "dist/server.js" });
    await approveExtension(history, "acme.backend", backend, 100);
    await approveExtension(history, "acme.plain", manifest("plain"), 100);
    expect((await extensionApprovals(history))("acme.backend", backend).approved).toBe(true);

    expect(await revokeExtensionApproval(history, "acme.backend")).toBe(true);
    expect(await revokeExtensionApproval(history, "acme.backend")).toBe(false);

    const verdict = (await extensionApprovals(history))("acme.backend", backend);
    expect(verdict.approved).toBe(false);
    expect(verdict.approvedBefore).toBe(false);
    expect((await approvedExtensions(history)).extensions.map((extension) => extension.id)).toEqual(["acme.plain"]);
});

test("a ledger this build cannot read lists nothing and says so, and taking one back never writes over it", async () => {
    const history = historyRoot();
    await approveExtension(history, "acme.plain", manifest("plain"), 100);
    await writeFile(join(history, "extension-approvals.json"), "{ not json");

    expect(await approvedExtensions(history)).toEqual({ extensions: [], unreadable: true });
    expect(await revokeExtensionApproval(history, "acme.plain")).toBe(false);
    expect(await readFile(join(history, "extension-approvals.json"), "utf8")).toBe("{ not json");
});

test("forgetting an extension's approval, as removal does, leaves nothing listed", async () => {
    const history = historyRoot();
    await approveExtension(history, "acme.plain", manifest("plain"), 100);
    await forgetExtensionApproval(history, "acme.plain");
    expect((await approvedExtensions(history)).extensions).toEqual([]);
});
