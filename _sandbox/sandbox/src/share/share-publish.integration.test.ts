import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SharePayload } from "@intentic/sandbox-contract";
import { expect, it } from "vitest";
import { publishShare, shareRoot, unpublishShare } from "./share-publish.js";

// Pins the tree a share becomes, against a real directory, since the claims are about files reaching the open internet;
// what matters most is what's absent: a picture that never left the workspace, a page gone after unpublish.

// Stands in for the built page bundle; small on purpose, since what's tested is the copying, not the app.
const viewer = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "share-viewer-"));
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(
        join(dir, "index.html"),
        `<!doctype html><html><head><title>Shared conversation</title>\n<script id="intentic-conversation" type="application/json">\nnull\n</script></head><body></body></html>`,
    );
    await writeFile(join(dir, "assets", "index.js"), "// the page");
    return dir;
};

// A workspace with pictures a conversation showed, where agents actually put them.
const workspace = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "share-workspace-"));
    await mkdir(join(dir, ".intentic/records/artifacts/browser"), { recursive: true });
    await writeFile(join(dir, ".intentic/records/artifacts/browser/after.png"), "PNG-BYTES");
    return dir;
};

const payload = (): SharePayload => ({
    title: "Login redirect fix",
    sharedAt: 1786372320000,
    detail: "everything",
    messages: [{ role: "user", text: "fix it" }],
});

const exists = async (path: string): Promise<boolean> =>
    stat(path)
        .then(() => true)
        .catch(() => false);

it("publishes a page, its pictures, and one copy of the viewer every share loads", async () => {
    const [root, dist] = await Promise.all([workspace(), viewer()]);
    await publishShare(root, dist, "login-redirect-fix-3f9c", payload(), [
        { source: ".intentic/records/artifacts/browser/after.png", published: "files/1-after.png" },
    ]);

    const share = join(shareRoot(root), "login-redirect-fix-3f9c");
    // The page carries its own conversation; nothing needs to be running to read it.
    expect(await readFile(join(share, "index.html"), "utf8")).toContain(`"title":"Login redirect fix"`);
    // The picture is a copy beside the page; nothing here names a workspace path.
    expect(await readFile(join(share, "files/1-after.png"), "utf8")).toBe("PNG-BYTES");
    expect(await exists(join(shareRoot(root), "_viewer/assets/index.js"))).toBe(true);
});

// A share is a snapshot re-taken under the same id; a second write must not leave the first one's leftovers.
it("re-sharing replaces what was there, pictures included", async () => {
    const [root, dist] = await Promise.all([workspace(), viewer()]);
    const id = "chat-1a2b";
    await publishShare(root, dist, id, payload(), [{ source: ".intentic/records/artifacts/browser/after.png", published: "files/1-after.png" }]);
    await publishShare(root, dist, id, payload(), []);

    expect(await exists(join(shareRoot(root), id, "index.html"))).toBe(true);
    expect(await exists(join(shareRoot(root), id, "files/1-after.png"))).toBe(false);
});

// Skipped rather than failing the share; the card then draws the picture's path as text. Mirrors what the outbox would
// refuse anyway.
it("never copies a picture from outside the workspace", async () => {
    const [root, dist] = await Promise.all([workspace(), viewer()]);
    await publishShare(root, dist, "chat-2b3c", payload(), [{ source: "../../etc/hosts", published: "files/1-hosts.png" }]);
    expect(await exists(join(shareRoot(root), "chat-2b3c", "files/1-hosts.png"))).toBe(false);
});

it("stop sharing takes the page and its pictures, and switches publishing off behind the last one", async () => {
    const [root, dist] = await Promise.all([workspace(), viewer()]);
    await publishShare(root, dist, "chat-3c4d", payload(), [
        { source: ".intentic/records/artifacts/browser/after.png", published: "files/1-after.png" },
    ]);
    await unpublishShare(root, "chat-3c4d");

    // The outbox directory itself is what "publishing is on" means; with no share left, it goes too.
    expect(await exists(join(root, "public"))).toBe(false);
});

it("leaves the outbox alone when something else is still published", async () => {
    const [root, dist] = await Promise.all([workspace(), viewer()]);
    await publishShare(root, dist, "chat-4d5e", payload(), []);
    await writeFile(join(root, "public", "report.pdf"), "PDF");
    await unpublishShare(root, "chat-4d5e");

    expect(await readdir(join(root, "public"))).toEqual(["report.pdf"]);
});

it("keeps other shares when one is withdrawn", async () => {
    const [root, dist] = await Promise.all([workspace(), viewer()]);
    await publishShare(root, dist, "chat-5e6f", payload(), []);
    await publishShare(root, dist, "chat-6f7a", payload(), []);
    await unpublishShare(root, "chat-5e6f");

    expect(await exists(join(shareRoot(root), "chat-6f7a", "index.html"))).toBe(true);
    expect(await exists(join(shareRoot(root), "_viewer/index.html"))).toBe(true);
});
