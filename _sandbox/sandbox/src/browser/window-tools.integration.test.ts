import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdaptorServer, type WebSocketServerLike } from "@hono/node-server";
import { requires } from "@intentic/testing/requires";
import { Hono } from "hono";
import type { BrowserContext, Page } from "playwright";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { call } from "@orpc/server";
import { unstubbed } from "@intentic/testing";
import type { AppEnv, OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { createDownloadsRoutes } from "./downloads/downloads.routes.js";
import { createMediaTickets } from "../auth/tokens/media-tickets.js";
import { parseActivePort } from "./sessions/owner-browser.js";
import { adoptBrowserSession, browserSessionState, browserWindowRecord, closeBrowserSession } from "./sessions/browser-sessions.js";
import { allDownloads, armDownloads, findDownload } from "./downloads/browser-downloads.js";
import { devtoolsBinding, devtoolsFrontendRoute, devtoolsSocketRoute } from "./devtools/devtools-proxy.js";
import { devtoolsPortOf } from "./devtools/devtools.routes.js";
import { answerPermissionAsk, configurePermissions, sitePermissions } from "./permissions/window-permissions.js";
import { answerFileChooser } from "./uploads/file-chooser.js";
import { dropFiles } from "./uploads/drop.js";
import { uploadedFiles, writeUploadPart } from "./uploads/upload-store.js";

/* The person's own window's tools through a real Chromium, started the way own-browser.ts starts it (a plain process
   with a debugging port, attached afterwards) but headless: a download lands in the profile's folder and is listed with
   the window; a file input's ask is held and answered with an upload; files dropped on a page reach its drop zone; a
   site's notification ask waits on the person and the answer is what the page and Chromium both see; a page prints to
   a PDF download; and DevTools' frontend and the page's socket come through the proxy behind their ticket. */

let playwright: typeof import("playwright") | undefined;
try {
    playwright = await import("playwright");
} catch {
    playwright = undefined;
}
const chromium = requires(
    playwright !== undefined && existsSync(playwright.chromium.executablePath()),
    "Playwright's Chromium",
    { absentOnCi: "no CI job that runs the daemon's suites installs the browser pack; the sandbox image carries it" },
);

const PAGE = `<!doctype html><title>Tools</title>
<a id="dl" href="/report.txt" download>report</a>
<input id="pick" type="file" multiple accept=".txt,image/*">
<div id="zone" style="position:absolute;left:0;top:200px;width:400px;height:200px">drop here</div>
<script>
  zone.addEventListener("dragover", (e) => e.preventDefault());
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.dataset.dropped = [...e.dataTransfer.files].map((f) => f.name + ":" + f.size).join(","); });
</script>`;

// Polls for a condition rather than sleeping a guess; generous but finite, so a regression fails rather than hangs.
const settle = async <T>(read: () => T | undefined | Promise<T | undefined>, ms = 15_000): Promise<T> => {
    for (let waited = 0; waited < ms; waited += 50) {
        const value = await read();
        if (value !== undefined) {
            return value;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("timed out waiting");
};

const NAME = "browser-tools-test";

describe.skipIf(!chromium.runs)(chromium.title("a window's downloads, uploads, permissions and page tools"), () => {
    let site: Server;
    let origin: string;
    let child: ChildProcess;
    let profile: string;
    let root: string;
    let context: BrowserContext;
    let page: Page;
    let port: number;

    beforeAll(async () => {
        site = createServer((request, response) => {
            if (request.url === "/report.txt") {
                response.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=report.txt" });
                response.end("quarterly numbers");
                return;
            }
            response.writeHead(200, { "content-type": "text/html" });
            response.end(PAGE);
        }).listen(0, "127.0.0.1");
        await once(site, "listening");
        origin = `http://127.0.0.1:${String(z.object({ port: z.number() }).parse(site.address()).port)}`;
        profile = mkdtempSync(join(tmpdir(), "browser-tools-profile-"));
        root = mkdtempSync(join(tmpdir(), "browser-tools-root-"));
        configurePermissions({ root });
        const executable = playwright?.chromium.executablePath() ?? "";
        child = spawn(executable, ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], {
            stdio: "ignore",
        });
        port = await settle(() => (existsSync(join(profile, "DevToolsActivePort")) ? parseActivePort(readFileSync(join(profile, "DevToolsActivePort"), "utf8")) : undefined));
        const browser = await playwright!.chromium.connectOverCDP(`http://127.0.0.1:${String(port)}`);
        context = browser.contexts()[0]!;
        adoptBrowserSession({ name: NAME, server: "_test", context, shutdown: async () => void child.kill("SIGKILL"), port });
        await armDownloads({ context, profile: "_test", root });
        page = context.pages()[0] ?? (await context.newPage());
        // The page's own DevTools session, where its permission asks and its file chooser are armed.
        await settle(() => browserWindowRecord(NAME)?.pages.values().next().value?.cdp);
        await page.goto(origin);
    }, 60_000);

    afterAll(async () => {
        await closeBrowserSession(NAME);
        child.kill("SIGKILL");
        site.close();
        rmSync(profile, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
    });

    test("a download lands in the profile's folder and is listed with the window", async () => {
        await page.click("#dl");
        const done = await settle(() => allDownloads().find((one) => one.name === "report.txt" && one.state === "done"));
        expect(done).toMatchObject({ url: `${origin}/report.txt`, receivedBytes: 17, totalBytes: 17 });
        const file = findDownload(done.id)?.file ?? "";
        expect(file.startsWith(join(root, ".intentic/local/browser/_test.downloads", done.id))).toBe(true);
        expect(readFileSync(file, "utf8")).toBe("quarterly numbers");
        expect(browserSessionState(NAME)?.downloads?.[0]).toMatchObject({ id: done.id, state: "done" });
    });

    test("a file input's ask is held for the person and answered with what they uploaded", async () => {
        await page.click("#pick");
        const chooser = await settle(() => browserSessionState(NAME)?.fileChooser);
        expect(chooser).toMatchObject({ multiple: true, accept: [".txt", "image/*"] });
        await writeUploadPart({ id: "test-upload-1", name: "notes.txt", offset: 0, body: new Blob(["picked on my laptop"]).stream() });
        expect(await answerFileChooser(page, chooser.id, await uploadedFiles(["test-upload-1"]))).toBe(true);
        expect(await page.evaluate(() => [...(document.querySelector<HTMLInputElement>("#pick")?.files ?? [])].map((file) => `${file.name}:${String(file.size)}`))).toEqual([
            "notes.txt:19",
        ]);
        await settle(() => (browserSessionState(NAME)?.fileChooser === undefined ? true : undefined));
    });

    test("files dropped on a page reach the drop zone under the point", async () => {
        await writeUploadPart({ id: "test-upload-2", name: "photo.png", offset: 0, body: new Blob(["png bytes"]).stream() });
        const session = browserWindowRecord(NAME)?.pages.values().next().value?.cdp;
        await dropFiles(page, session!, 50, 250, await uploadedFiles(["test-upload-2"]));
        const dropped = (): Promise<string> => page.evaluate(() => document.querySelector("#zone")?.getAttribute("data-dropped") ?? "");
        expect(await settle(async () => ((await dropped()) === "" ? undefined : dropped()))).toBe("photo.png:9");
    });

    test("a site's notification ask waits on the person, and the answer is the page's and Chromium's", async () => {
        const asked = page.evaluate(() => Notification.requestPermission());
        const ask = await settle(() => browserSessionState(NAME)?.permissionAsk);
        expect(ask).toMatchObject({ origin, permission: "notifications" });
        await answerPermissionAsk(browserWindowRecord(NAME)!, ask.id, "allow");
        expect(await asked).toBe("granted");
        expect(await page.evaluate(() => Notification.permission)).toBe("granted");
        const decided = await sitePermissions(browserWindowRecord(NAME)!, origin);
        expect(decided.permissions.find((one) => one.permission === "notifications")?.setting).toBe("allow");
        // Remembered: the next ask is answered from the store without the person.
        expect(await page.evaluate(() => Notification.requestPermission())).toBe("granted");
    });

    test("the camera is refused at once and the person told", async () => {
        const refused = await page.evaluate(() => navigator.mediaDevices.getUserMedia({ video: true }).then(() => "stream", (error: Error) => error.name));
        expect(refused).toBe("NotFoundError");
        expect(await settle(() => browserSessionState(NAME)?.permissionAsk)).toMatchObject({ permission: "camera", unavailable: true });
    });

    test("DevTools' frontend and the page's socket come through the proxy behind their ticket", async () => {
        const tickets = createMediaTickets();
        const deps = { mediaTickets: tickets, portOf: devtoolsPortOf };
        const app = new Hono<AppEnv>()
            .get("/browser/devtools/:ticket/ws/:kind/:target", devtoolsSocketRoute(deps))
            .get("/browser/devtools/:ticket/*", devtoolsFrontendRoute(deps));
        // SAFETY: ws's own server is the one hono's adapter is written against (desktop-view.integration.test.ts).
        const server = createAdaptorServer({ fetch: app.fetch, websocket: { server: new WebSocketServer({ noServer: true }) as WebSocketServerLike } });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const at = `127.0.0.1:${String(z.object({ port: z.number() }).parse(server.address()).port)}`;
        try {
            const session = browserWindowRecord(NAME)?.pages.values().next().value?.cdp;
            const { targetInfo } = await session!.send("Target.getTargetInfo");
            const ticket = tickets.mint(devtoolsBinding(NAME, targetInfo.targetId)).ticket;
            const frontend = await fetch(`http://${at}/browser/devtools/${ticket}/inspector.html`);
            expect(frontend.status).toBe(200);
            expect(await frontend.text()).toContain("<!DOCTYPE html>");
            const socket = new WebSocket(`ws://${at}/browser/devtools/${ticket}/ws/page/${targetInfo.targetId}`);
            const answer = new Promise<string>((resolve) => socket.on("message", (data) => resolve(String(data))));
            await once(socket, "open");
            socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } }));
            expect(JSON.parse(await answer)).toMatchObject({ id: 1, result: { result: { value: "Tools" } } });
            socket.close();
            // Another page's id under this ticket is refused before anything reaches Chromium.
            const other = new WebSocket(`ws://${at}/browser/devtools/${ticket}/ws/page/0123456789ABCDEF0123456789ABCDEF`);
            const closed = new Promise<number>((resolve) => other.on("close", (code) => resolve(code)));
            expect(await closed).toBe(1008);
        } finally {
            server.close();
        }
    });

    test("a page prints to a PDF listed with the downloads, and a download saves into the workspace and nowhere else", async () => {
        const routes = createDownloadsRoutes({
            mediaTickets: createMediaTickets(),
            workspace: unstubbed<Services["workspace"]>("workspace", { root }),
            areas: unstubbed<Services["areas"]>("areas", { list: async () => [] }),
            history: unstubbed<Services["history"]>("history", { notifyUserWrite: () => undefined }),
        });
        const caller: OrpcContext = { headers: new Headers(), method: "POST", url: "/browser", identity: { email: "max@example.com", tier: "maintainer", methods: ["google"] } };
        const pageId = [...(browserWindowRecord(NAME)?.pages.keys() ?? [])][0] ?? "";
        const printed = await call(routes.printPage, { name: NAME, pageId }, { context: caller });
        expect(printed).toMatchObject({ name: "Tools.pdf", url: `${origin}/`, state: "done" });
        expect(readFileSync(findDownload(printed.id)?.file ?? "").subarray(0, 5).toString()).toBe("%PDF-");
        expect(browserSessionState(NAME)?.downloads?.[0]?.id).toBe(printed.id);
        expect(await call(routes.saveDownload, { id: printed.id }, { context: caller })).toEqual({ path: "downloads/Tools.pdf" });
        expect(await call(routes.saveDownload, { id: printed.id }, { context: caller })).toEqual({ path: "downloads/Tools (1).pdf" });
        expect(readFileSync(join(root, "downloads/Tools (1).pdf")).subarray(0, 5).toString()).toBe("%PDF-");
        await expect(call(routes.saveDownload, { id: printed.id, folder: "../outside" }, { context: caller })).rejects.toThrow("inside the workspace");
        await expect(call(routes.saveDownload, { id: printed.id, folder: ".intentic/config" }, { context: caller })).rejects.toThrow("inside the workspace");
        await expect(call(routes.saveDownload, { id: printed.id, folder: "repo/.git/hooks" }, { context: caller })).rejects.toThrow("inside the workspace");
    });
});
