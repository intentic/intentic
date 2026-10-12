import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pagesContract } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { errorCode, routesClient } from "../../harness/route-client.testing.js";
import { PAGES_DIR } from "./pages-dir.js";
import { createPagesRoutes, type PagesRoutesDeps } from "./pages.routes.js";

// The page an app call names is read off disk, so the route must keep it to the pages folder: the old test looked at the
// raw string's prefix, which `../` walks straight past. Real directories and a real symlink.

// A workspace with one stored page (no MCP app inside it), an ordinary file elsewhere, and a link in the pages folder
// that leads out of the workspace.
const pagesWorkspace = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "pages-route-"));
    const outside = await mkdtemp(join(tmpdir(), "pages-route-outside-"));
    await mkdir(join(root, PAGES_DIR, "conv"), { recursive: true });
    await writeFile(join(root, PAGES_DIR, "conv/a.html"), "<p>a page</p>");
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs/x.html"), "<p>not a page</p>");
    await writeFile(join(outside, "x.html"), "<p>outside</p>");
    await symlink(outside, join(root, PAGES_DIR, "away"));
    return root;
};

const client = (root: string) =>
    routesClient(
        pagesContract,
        createPagesRoutes(
            unstubbed<PagesRoutesDeps>("pages", {
                workspace: unstubbed<PagesRoutesDeps["workspace"]>("workspace", { root }),
                capabilities: unstubbed<PagesRoutesDeps["capabilities"]>("capabilities", { list: async () => [] }),
            }),
        ),
    );

test("appCall refuses a page path that climbs out of the pages folder", async () => {
    const root = await pagesWorkspace();
    expect(await errorCode(client(root).appCall({ page: `${PAGES_DIR}../../../../docs/x.html`, name: "t" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client(root).appCall({ page: `${PAGES_DIR}conv/../../../../../docs/x.html`, name: "t" }))).toBe("BAD_REQUEST");
});

test("appCall refuses a page reached through a link out of the pages folder", async () => {
    const root = await pagesWorkspace();
    expect(await errorCode(client(root).appCall({ page: `${PAGES_DIR}away/x.html`, name: "t" }))).toBe("BAD_REQUEST");
});

test("appCall reads a stored page, and answers that it holds no app", async () => {
    const root = await pagesWorkspace();
    expect(await errorCode(client(root).appCall({ page: `${PAGES_DIR}conv/a.html`, name: "t" }))).toBe("NOT_FOUND");
});
