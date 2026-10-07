import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rename } from "@intentic/sandbox-contract/documents";
import { waitFor } from "@intentic/testing/bun";
import { z } from "zod";
import { connectExtensionProcess } from "./runtime.js";
import type { ExtensionServerApi, ServerActivation, StoredJson } from "./server.js";
import { type FakeExtension, fakeExtensionApi } from "./testing.js";

// The backend api as a server bundle and a process both get it (runtime.ts), driven through the SDK's own fake daemon
// (testing.ts), which judges every call by the reach rule the daemon's grant applies.

const opened: FakeExtension[] = [];
const fake = async (options: Parameters<typeof fakeExtensionApi>[0]): Promise<FakeExtension> => {
    const made = await fakeExtensionApi(options);
    opened.push(made);
    return made;
};
afterEach(async () => {
    await Promise.all(opened.splice(0).map((each) => each.dispose()));
});

const manifest = { publisher: "acme", name: "probe", permissions: { daemon: ["GET /ports"] } };

test("a call the manifest declares reaches the daemon, and one it does not is refused there", async () => {
    const extension = await fake({ manifest, daemon: () => Response.json({ ports: [] }) });
    expect((await extension.api.daemon.request("/ports")).status).toBe(200);
    expect((await extension.api.daemon.request("/agents")).status).toBe(403);
    expect(extension.calls).toEqual([
        { line: "GET /ports", admitted: true },
        { line: "GET /agents", admitted: false },
    ]);
});

test("a typed call outside permissions.daemon is refused before anything is sent", async () => {
    const extension = await fake({ manifest });
    await expect(extension.api.daemon.rpc.extensions.settings({ id: "acme.probe" })).rejects.toThrow(/declare it in permissions\.daemon/);
    expect(extension.calls).toEqual([]);
});

test("its own settings and event stream need no declaration, and a change names the keys that moved", async () => {
    const extension = await fake({ manifest: { publisher: "acme", name: "quiet" }, settings: { engine: "browser", autoStart: false } });
    expect(await extension.api.settings.get()).toEqual({ engine: "browser", autoStart: false });
    const heard: (readonly string[])[] = [];
    const subscription = extension.api.settings.onDidChange((keys) => heard.push(keys));
    extension.setSettings({ engine: "server", autoStart: false });
    await waitFor(() => expect(heard).toHaveLength(1));
    expect(heard).toEqual([["engine"]]);
    expect(await extension.api.settings.get()).toEqual({ engine: "server", autoStart: false });
    subscription.dispose();
    expect(extension.calls.every((call) => call.admitted)).toBe(true);
});

test("workspace changes arrive as the daemon frames them, and a listener that throws does not stop the rest", async () => {
    const extension = await fake({ manifest });
    const files: (readonly string[])[] = [];
    const refs: (readonly string[])[] = [];
    extension.api.workspace.onDidChangeFiles(() => {
        throw new Error("boom");
    });
    extension.api.workspace.onDidChangeFiles((paths) => files.push(paths));
    extension.api.workspace.onDidChangeRefs((repos) => refs.push(repos));
    extension.emit({ kind: "files", paths: ["src/a.ts"] });
    extension.emit({ kind: "refs", repos: ["app"] });
    await waitFor(() => {
        expect(files).toHaveLength(1);
        expect(refs).toHaveLength(1);
    });
    expect(files).toEqual([["src/a.ts"]]);
    expect(refs).toEqual([["app"]]);
    expect(extension.logs.some((line) => line.includes("a files listener threw: boom"))).toBe(true);
});

const MarksSchema = z.object({ lastUid: z.number() });
type Marks = z.infer<typeof MarksSchema>;
const parseMarks = (raw: StoredJson): Marks | undefined => MarksSchema.safeParse(raw).data;

test("a document reads an older shape through its conversions and keeps what a newer version wrote", async () => {
    const extension = await fake({ manifest });
    const file = join(extension.api.stateDir, "marks.json");
    await writeFile(file, JSON.stringify({ uid: 7, addedLater: "kept" }));
    const marks = extension.api.document("marks.json", { parse: parseMarks, fallback: () => ({ lastUid: 0 }), history: [rename("uid", "lastUid")] });
    expect(await marks.read()).toEqual({ lastUid: 7 });
    expect(await marks.update((current) => ({ lastUid: current.lastUid + 1 }))).toEqual({ lastUid: 8 });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ lastUid: 8, addedLater: "kept" });
});

test("a document this version cannot read is left as it is rather than written over", async () => {
    const extension = await fake({ manifest });
    const file = join(extension.api.stateDir, "marks.json");
    await writeFile(file, "not json");
    const marks = extension.api.document("marks.json", { parse: parseMarks, fallback: () => ({ lastUid: 0 }) });
    expect(await marks.read()).toEqual({ lastUid: 0 });
    await expect(marks.update(() => ({ lastUid: 1 }))).rejects.toThrow(/cannot read/);
    expect(await readFile(file, "utf8")).toBe("not json");
    expect(() => extension.api.document("../escape.json", { parse: parseMarks, fallback: () => ({ lastUid: 0 }) })).toThrow(/inside the extension's state directory/);
});

test("a server module is activated, served and wound down the way the backend host does it", async () => {
    const extension = await fake({ manifest });
    let deactivated = false;
    await extension.activate({
        activateServer: (api: ExtensionServerApi): ServerActivation => {
            api.routes.mount(async (request) => (new URL(request.url).pathname === "/hello" ? Response.json({ hello: api.stateDir !== "" }) : undefined));
            api.tools.serve(() => [{ name: "echo", description: "echoes", inputSchema: { type: "object" }, effect: "read", call: (args) => args["text"] }]);
            return {
                deactivate: () => {
                    deactivated = true;
                },
                health: () => ({ state: "degraded", detail: "the mailbox is not answering" }),
            };
        },
    });
    expect(await (await extension.route("/hello")).json()).toEqual({ hello: true });
    expect((await extension.route("/missing")).status).toBe(404);
    expect((await extension.tools()).map((tool) => tool.name)).toEqual(["echo"]);
    expect(await extension.callTool("echo", { text: "hi" })).toBe("hi");
    expect(await extension.health()).toEqual({ state: "degraded", detail: "the mailbox is not answering" });
    await extension.deactivate();
    expect(deactivated).toBe(true);
});

test("a health check that answers outside the vocabulary reads as degraded, saying so", async () => {
    const extension = await fake({ manifest });
    // SAFETY: an answer outside the vocabulary is the case under test, which the type would otherwise refuse to state.
    await extension.activate({ activateServer: () => ({ health: () => ({ state: "fine" }) as never }) });
    expect(await extension.health()).toEqual({ state: "degraded", detail: "its health check answered something other than ok, starting, degraded or failed" });
});

test("a process started without the daemon's environment says which variable is missing", async () => {
    expect(() => connectExtensionProcess({})).toThrow(/missing INTENTIC_EXTENSION_ID/);
    const root = await mkdtemp(join(tmpdir(), "process-env-"));
    try {
        const connected = connectExtensionProcess({
            INTENTIC_EXTENSION_ID: "acme.probe",
            INTENTIC_DAEMON: "http://127.0.0.1:1",
            INTENTIC_EXTENSION_TOKEN: "t",
            INTENTIC_WORKSPACE: root,
            INTENTIC_EXTENSION_STATE: join(root, "state"),
            INTENTIC_EXTENSION_CACHE: join(root, "cache"),
            INTENTIC_EXTENSION_PERMISSIONS: JSON.stringify(["GET /ports"]),
        });
        expect(connected.api.stateDir).toBe(join(root, "state"));
        expect(connected.api.workspaceRoot).toBe(root);
        connected.close();
        const env = {
            INTENTIC_EXTENSION_ID: "acme.probe",
            INTENTIC_DAEMON: "http://127.0.0.1:1",
            INTENTIC_EXTENSION_TOKEN: "t",
            INTENTIC_WORKSPACE: root,
            INTENTIC_EXTENSION_STATE: root,
            INTENTIC_EXTENSION_CACHE: root,
        };
        expect(() => connectExtensionProcess({ ...env, INTENTIC_EXTENSION_PERMISSIONS: "{}" })).toThrow(/not a JSON array/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
