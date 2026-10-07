import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PageNotFoundError, publishPage, purgePages } from "./page-store.js";

describe("publishPage", () => {
    let root: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "page-store-"));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("files a page under its conversation, whole on its own, and describes it for the row", async () => {
        const page = await publishPage({ workspaceRoot: root, conversationId: "conv-1", title: "  Q3  ", html: "<p>q3</p>", height: 5000, measured: 412.4 });
        expect(page.path).toBe(`.intentic/records/artifacts/pages/conv-1/${page.id}.r0.html`);
        expect(page).toMatchObject({ title: "Q3", height: 2000, measured: 412 });
        expect(page.revision).toBeUndefined();
        const stored = readFileSync(join(root, page.path), "utf8");
        expect(stored).toContain("<p>q3</p>");
        expect(stored).toContain(`id="intentic-page-defaults"`);
    });

    it("redraws a page as a new file under the same id, and refuses one this conversation never showed", async () => {
        const first = await publishPage({ workspaceRoot: root, conversationId: "conv-1", title: "A", html: "<p>1</p>" });
        const second = await publishPage({ workspaceRoot: root, conversationId: "conv-1", title: "A", html: "<p>2</p>", replaces: first.id });
        expect(second.id).toBe(first.id);
        expect(second.revision).toBe(1);
        expect(second.path).not.toBe(first.path);
        expect(readFileSync(join(root, first.path), "utf8")).toContain("<p>1</p>");
        await expect(publishPage({ workspaceRoot: root, conversationId: "conv-2", title: "A", html: "x", replaces: first.id })).rejects.toBeInstanceOf(
            PageNotFoundError,
        );
    });

    it("goes with its conversation", async () => {
        const page = await publishPage({ workspaceRoot: root, conversationId: "conv-1", title: "A", html: "x" });
        await purgePages(root, "conv-1");
        expect(() => readFileSync(join(root, page.path))).toThrow();
    });
});
