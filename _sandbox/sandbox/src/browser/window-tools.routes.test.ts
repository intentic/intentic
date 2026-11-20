import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { SANDBOX_ROUTES } from "@intentic/sandbox-contract";
import { routeAccess } from "@intentic/sandbox-contract/protocol/route-meta";
import { RAW_ROUTE_LIST } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import { createMediaTickets } from "../auth/tokens/media-tickets.js";
import { devtoolsBinding, devtoolsFrontendRoute } from "./devtools/devtools-proxy.js";
import { downloadFileRoute } from "./downloads/downloads.routes.js";

/* Who reaches what a browser window does besides its pages. Every route of it is operating the window, as taking the
   wheel over its picture is (the browser view's ticket is redeemed at maintainer), so each typed route floors there,
   reads included. The three a header cannot reach (a saved file, the DevTools frame and its socket) check a ticket in
   the handler, minted at maintainer by a typed route, and a ticket for anything else (a workspace file, another
   window's page) opens nothing. */

describe("the browser routes' floors", () => {
    test("every typed browser route is the maintainer's, and no control token reaches it", () => {
        const routes = SANDBOX_ROUTES.filter((route) => route.name.startsWith("browser."));
        expect(routes.map((route) => route.name).toSorted()).toEqual(
            [
                "browser.answerFileChooser",
                "browser.answerPermission",
                "browser.cancelDownload",
                "browser.clearSiteData",
                "browser.devtools",
                "browser.downloadTicket",
                "browser.downloads",
                "browser.dropFiles",
                "browser.printPage",
                "browser.removeDownload",
                "browser.saveDownload",
                "browser.setSitePermission",
                "browser.site",
                "browser.startRecording",
                "browser.stopRecording",
                "browser.viewSource",
            ].toSorted(),
        );
        for (const route of routes) {
            expect({ route: route.name, ...routeAccess(route.method, route.meta) }).toMatchObject({ route: route.name, floor: "maintainer", control: "never", guest: false });
        }
    });

    test("the upload is the maintainer's, and the ticketed doors take no session at all", () => {
        const raw = Object.fromEntries(RAW_ROUTE_LIST.filter((route) => route.path.startsWith("/browser/")).map((route) => [route.name, routeAccess(route.method, route.meta)]));
        expect(Object.keys(raw).toSorted()).toEqual(
            ["GET /browser/devtools/{ticket}/*", "GET /browser/devtools/{ticket}/ws/{kind}/{target}", "GET /browser/downloads/file", "POST /browser/uploads"].toSorted(),
        );
        expect(raw["POST /browser/uploads"]).toMatchObject({ auth: "session", floor: "maintainer", guest: false, control: "never" });
        for (const door of ["GET /browser/downloads/file", "GET /browser/devtools/{ticket}/*", "GET /browser/devtools/{ticket}/ws/{kind}/{target}"]) {
            expect(raw[door]).toMatchObject({ auth: "door", guest: false, control: "never" });
        }
    });
});

describe("the ticketed doors", () => {
    const stand = () => {
        const tickets = createMediaTickets();
        const app = new Hono<AppEnv>()
            .get("/browser/downloads/file", downloadFileRoute({ mediaTickets: tickets }))
            // A window by this name runs, on a port nothing listens on: past the ticket, the request would reach for it.
            .get("/browser/devtools/:ticket/*", devtoolsFrontendRoute({ mediaTickets: tickets, portOf: (window) => (window === "browser-own" ? 1 : undefined) }));
        return { tickets, app };
    };

    test("a saved file without a live ticket is refused", async () => {
        const { app } = stand();
        expect((await app.request("/browser/downloads/file")).status).toBe(401);
        expect((await app.request("/browser/downloads/file?ticket=made-up")).status).toBe(401);
    });

    test("a ticket minted for a workspace file does not open a download", async () => {
        const { tickets, app } = stand();
        const workspace = tickets.mint(join(WORKSPACE_ROOT, "secrets.txt")).ticket;
        expect((await app.request(`/browser/downloads/file?ticket=${workspace}`)).status).toBe(401);
    });

    test("a download ticket for one that is not kept opens nothing", async () => {
        const { tickets, app } = stand();
        const unknown = tickets.mint("browser-download:0000aaaa-0000-0000-0000-000000000000").ticket;
        expect((await app.request(`/browser/downloads/file?ticket=${unknown}`)).status).toBe(401);
    });

    test("DevTools without a ticket for a running window is refused", async () => {
        const { tickets, app } = stand();
        expect((await app.request("/browser/devtools/made-up/inspector.html")).status).toBe(401);
        const workspace = tickets.mint(join(WORKSPACE_ROOT, "notes.md")).ticket;
        expect((await app.request(`/browser/devtools/${workspace}/inspector.html`)).status).toBe(401);
        const closed = tickets.mint(devtoolsBinding("browser-gone", "ABCDEF0123456789")).ticket;
        expect((await app.request(`/browser/devtools/${closed}/inspector.html`)).status).toBe(401);
    });

    test("a DevTools ticket opens only the frontend's own files, never a way out of /devtools/", async () => {
        const { tickets, app } = stand();
        const ticket = tickets.mint(devtoolsBinding("browser-own", "ABCDEF0123456789")).ticket;
        expect((await app.request(`/browser/devtools/${ticket}/..%2Fjson%2Flist`)).status).toBe(404);
        expect((await app.request(`/browser/devtools/${ticket}/inspector.html%00`)).status).toBe(404);
        expect((await app.request(`/browser/devtools/${ticket}/inspector.html?x=1`)).status).toBe(502);
    });
});
