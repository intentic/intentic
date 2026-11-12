import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pagesContract } from "@intentic/sandbox-contract/contracts/pages.contract";
import { pageMediaScript } from "@intentic/sandbox-contract/text/pages";
import type { ProvenCaller } from "../../auth/auth.js";
import { createMediaTickets } from "../../auth/tokens/media-tickets.js";
import { pageMediaKeyPath, signPageMedia } from "./page-media.js";
import { pageMediaBinding } from "./page-media.routes.js";
import { unstubbed } from "@intentic/testing";
import { errorCode, routesClient } from "../../harness/route-client.testing.js";
import { PAGES_DIR } from "./pages-dir.js";
import { createPagesRoutes, type PagesRoutesDeps } from "./pages.routes.js";

// The page an app call names is read off disk, so the route must keep it to the pages folder: the old test looked at the
// raw string's prefix, which `../` walks straight past. Real directories and a real symlink.

// A workspace with one stored page (no MCP app inside it), an ordinary file elsewhere, and a link in the pages folder
// that leads out of the workspace.
// The daemon's own state, where the manifest key lives: beside the workspace, as /history is beside /work.
const historyOf = (root: string): string => `${root}-history`;

const pagesWorkspace = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "pages-route-"));
    const outside = await mkdtemp(join(tmpdir(), "pages-route-outside-"));
    await mkdir(join(root, PAGES_DIR, "conv"), { recursive: true });
    await writeFile(join(root, PAGES_DIR, "conv/a.html"), "<p>a page</p>");
    // One page whose manifest the daemon signed for it, and one whose manifest nobody signed.
    const files = [{ path: join(root, "take1.mp4"), type: "video/mp4", size: 10, mtimeMs: 1 }];
    const signed = await signPageMedia(pageMediaKeyPath(historyOf(root)), `${PAGES_DIR}conv/takes.html`, files);
    await writeFile(join(root, PAGES_DIR, "conv/takes.html"), `<head>${pageMediaScript(signed)}</head><video src="intentic-media:0"></video>`);
    await writeFile(join(root, PAGES_DIR, "conv/forged.html"), `<head>${pageMediaScript({ files, signature: "x" })}</head><video src="intentic-media:0"></video>`);
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs/x.html"), "<p>not a page</p>");
    await writeFile(join(outside, "x.html"), "<p>outside</p>");
    await symlink(outside, join(root, PAGES_DIR, "away"));
    return root;
};

type Entry = NonNullable<ReturnType<PagesRoutesDeps["agents"]["entry"]>>;

// The conversation that showed the pages, `conv`, is Ada's.
const client = (root: string, tickets = createMediaTickets(), caller?: ProvenCaller) =>
    routesClient(
        pagesContract,
        createPagesRoutes(
            unstubbed<PagesRoutesDeps>("pages", {
                workspace: unstubbed<PagesRoutesDeps["workspace"]>("workspace", { root }),
                capabilities: unstubbed<PagesRoutesDeps["capabilities"]>("capabilities", { list: async () => [] }),
                areas: unstubbed<PagesRoutesDeps["areas"]>("areas", { list: async () => [] }),
                agents: unstubbed<PagesRoutesDeps["agents"]>("agents", {
                    entry: (id) =>
                        id === "conv"
                            ? unstubbed<Entry>("entry", {
                                  identity: unstubbed<Entry["identity"]>("identity", { startedBy: undefined, areas: undefined, home: undefined, fresh: undefined }),
                                  social: unstubbed<Entry["social"]>("social", { owner: { email: "ada@example.com", since: 0 } }),
                                  seal: undefined,
                              })
                            : undefined,
                }),
                workspaceScope: unstubbed<PagesRoutesDeps["workspaceScope"]>("workspaceScope", {}),
                config: unstubbed<PagesRoutesDeps["config"]>("config", { historyRoot: historyOf(root) }),
                mediaTickets: tickets,
            }),
        ),
        caller,
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

test("mediaTicket mints a pass bound to a stored page that streams video, and to nothing else", async () => {
    const root = await pagesWorkspace();
    const tickets = createMediaTickets();
    const { ticket, expiresAt } = await client(root, tickets).mediaTicket({ page: `${PAGES_DIR}conv/takes.html` });
    expect(tickets.bound(ticket)).toBe(pageMediaBinding(`${PAGES_DIR}conv/takes.html`));
    expect(expiresAt).toBeGreaterThan(Date.now());
});

test("mediaTicket refuses a page whose manifest the daemon did not sign, and a caller who may not see the conversation that showed it", async () => {
    const root = await pagesWorkspace();
    expect(await errorCode(client(root).mediaTicket({ page: `${PAGES_DIR}conv/forged.html` }))).toBe("NOT_FOUND");
    const guest: ProvenCaller = { email: "dee@example.com", role: "guest", methods: ["google"] };
    expect(await errorCode(client(root, createMediaTickets(), guest).mediaTicket({ page: `${PAGES_DIR}conv/takes.html` }))).toBe("FORBIDDEN");
    const owner: ProvenCaller = { email: "ada@example.com", role: "guest", methods: ["google"] };
    const tickets = createMediaTickets();
    const { ticket } = await client(root, tickets, owner).mediaTicket({ page: `${PAGES_DIR}conv/takes.html` });
    expect(tickets.bound(ticket)).toBe(pageMediaBinding(`${PAGES_DIR}conv/takes.html`));
});

test("mediaTicket refuses a page that streams nothing, and a path out of the pages folder", async () => {
    const root = await pagesWorkspace();
    expect(await errorCode(client(root).mediaTicket({ page: `${PAGES_DIR}conv/a.html` }))).toBe("NOT_FOUND");
    expect(await errorCode(client(root).mediaTicket({ page: `${PAGES_DIR}away/x.html` }))).toBe("NOT_FOUND");
    expect(await errorCode(client(root).mediaTicket({ page: `${PAGES_DIR}../../../../docs/x.html` }))).toBe("NOT_FOUND");
});
