import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxContract, sandboxRouteFor } from "@intentic/sandbox-contract";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import { createApp } from "../app.js";
import { memoryCapabilitiesStore } from "../capabilities/capabilities-slice.testing.js";
import { extensionDir } from "../capabilities/extension-dirs.js";
import { clientFor, errorCode } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import type { ServiceProcesses } from "../processes/service-processes.js";
import { unstubbed } from "@intentic/testing";
import { testConfig } from "../testing.js";
import { removeWorkspacePath } from "../workspace/files/workspace-files.js";
import { fakeFiles } from "../workspace/workspace-slice.testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { readExtensionDev, worktreesRootOf } from "./extension-dev.js";
import { extensionProcessKey } from "./extension-processes.js";

// Dev mode over the daemon's HTTP surface, the way the `extension` CLI and the Extensions tab drive it: the checkout is
// found by the address the extension was installed from, served in place of the pinned copy (bundle, processes) until
// the way back is taken, and a removal takes the pinned copy and the pointer but never the checkout.

const URL = "https://github.com/intentic/extension-maintenance.git";
const ID = "intentic-maintenance";
const PINNED_HEAD = "a".repeat(40);

const MANIFEST = {
    publisher: "intentic",
    name: "maintenance",
    version: "1.0.0",
    engines: { intentic: "^0.2.0" },
    entry: "dist/extension.js",
    contributes: { processes: [{ name: "probe", command: "node dist/probe.js", autoStart: true }] },
};

const writeExtension = async (dir: string, body: object, bundle: string | undefined): Promise<void> => {
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "intentic-extension.json"), JSON.stringify(body));
    if (bundle !== undefined) {
        await writeFile(join(dir, "dist", "extension.js"), bundle);
    }
};

// `null` for a checkout not built yet.
const checkoutAt = async (
    dir: string,
    body: object = MANIFEST,
    bundle: string | null = "export const activate = () => {}; // dev",
): Promise<void> => {
    await writeExtension(dir, body, bundle ?? undefined);
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", URL]);
};

// The supervisor's own rules, kept: start() leaves a running key alone, so a process only moves if it is stopped first.
const liveProcesses = (seed: Record<string, string>) => {
    const live = new Map(Object.entries(seed));
    const started: { key: string; cwd: string }[] = [];
    const stopped: string[] = [];
    const statusOf = (key: string) => {
        const cwd = live.get(key);
        return cwd === undefined ? undefined : { key, state: "running" as const, port: 4100, restarts: 0, since: 0, cwd };
    };
    const processes = unstubbed<ServiceProcesses>("serviceProcesses", {
        start: async (key, spec) => {
            if (!live.has(key)) {
                live.set(key, spec.cwd);
                started.push({ key, cwd: spec.cwd });
            }
        },
        stop: (key) => {
            if (live.delete(key)) {
                stopped.push(key);
            }
        },
        running: (key) => live.has(key),
        portOf: (key) => (live.has(key) ? 4100 : undefined),
        statusOf,
        list: () => [...live.keys()].flatMap((key) => statusOf(key) ?? []),
        logPathOf: () => undefined,
        stopAll: () => live.clear(),
    });
    return Object.assign(processes, { started, stopped });
};

// A client whose calls arrive from one conversation's shell, as the CLI sends them.
const clientAs = (app: Hono<AppEnv>, conversation: string): ContractRouterClient<typeof sandboxContract> =>
    createORPCClient(
        new OpenAPILink(sandboxContract, {
            url: "http://sandbox",
            fetch: async (request) =>
                app.request(new Request(request, { headers: { ...Object.fromEntries(request.headers), "x-intentic-conversation": conversation } })),
        }),
    );

// A workspace holding a pinned install of intentic.maintenance whose probe process runs from the pinned copy.
const setup = async () => {
    const workspace = workspacePaths(realpathSync(mkdtempSync(join(tmpdir(), "ext-dev-routes-"))));
    const historyRoot = realpathSync(mkdtempSync(join(tmpdir(), "ext-dev-routes-history-")));
    const pinned = extensionDir(workspace.root, ID);
    await writeExtension(pinned, MANIFEST, "export const activate = () => {}; // pinned");
    const probe = extensionProcessKey(ID, "probe");
    const serviceProcesses = liveProcesses({ [probe]: pinned });
    const svc = services({
        workspace,
        config: { ...testConfig, historyRoot },
        capabilities: memoryCapabilitiesStore([{ id: ID, kind: "extension", config: { url: URL, ref: PINNED_HEAD } }]),
        git: { fullHead: async () => PINNED_HEAD, head: async () => PINNED_HEAD.slice(0, 7) },
        serviceProcesses,
        files: fakeFiles({ remove: removeWorkspacePath }),
    });
    const app = createApp(svc);
    return { workspace, historyRoot, pinned, probe, serviceProcesses, svc, app, client: clientFor(app) };
};

test("dev mode is reachable by the agent token the CLI carries", () => {
    for (const [method, path] of [
        ["GET", "/extensions/dev"],
        ["POST", "/extensions/maintenance/dev"],
        ["POST", "/extensions/maintenance/dev/clear"],
        ["POST", "/extensions/maintenance/dev/reload"],
    ] as const) {
        expect(sandboxRouteFor(method, path)?.meta.agent).toBe(true);
    }
});

test("pointing an install at its checkout by name finds it by address, serves it, and the way back restores the pinned copy", async () => {
    const { workspace, pinned, probe, serviceProcesses, app, client } = await setup();
    const checkout = join(workspace.root, "extensions", "maintenance");
    await checkoutAt(checkout);

    const pinnedBundle = await app.request(`/extensions/${ID}/bundle`);
    expect(pinnedBundle.headers.get("etag")).toBe(PINNED_HEAD.slice(0, 7));

    const set = await client.extensions.devSet({ id: "maintenance" });
    expect(set).toEqual({
        id: ID,
        name: "intentic.maintenance",
        dev: { path: "extensions/maintenance", uncommitted: 2, revision: expect.stringMatching(/^[0-9a-f]{12}$/) },
    });
    expect((await readExtensionDev(workspace.root))[ID]).toMatchObject({ path: checkout });

    // The row keeps naming the pinned commit, beside where it actually runs from.
    const row = (await client.extensions.list()).extensions.find((extension) => extension.id === ID);
    expect(row).toMatchObject({ source: "installed", commit: PINNED_HEAD, dev: { path: "extensions/maintenance" } });

    // The bundle is the checkout's, fingerprinted by its bytes: the pinned sha would let a rebuild hide behind a 304.
    const devBundle = await app.request(`/extensions/${ID}/bundle`);
    expect(await devBundle.text()).toContain("// dev");
    const etag = devBundle.headers.get("etag") ?? "";
    expect(etag).toMatch(/^[0-9a-f]{64}$/);
    expect(etag.slice(0, 12)).toBe(set.dev.revision ?? "");
    await writeFile(join(checkout, "dist", "extension.js"), "export const activate = () => {}; // rebuilt");
    expect((await app.request(`/extensions/${ID}/bundle`, { headers: { "if-none-match": etag } })).status).toBe(200);

    // Its running process moved onto the checkout.
    expect(serviceProcesses.stopped).toContain(probe);
    expect(serviceProcesses.started).toContainEqual({ key: probe, cwd: checkout });

    expect(await client.extensions.devClear({ id: "intentic.maintenance" })).toEqual({ id: ID, name: "intentic.maintenance", cleared: true });
    expect(await readExtensionDev(workspace.root)).toEqual({});
    expect((await client.extensions.list()).extensions.find((extension) => extension.id === ID)?.dev).toBeUndefined();
    const back = await app.request(`/extensions/${ID}/bundle`);
    expect(await back.text()).toContain("// pinned");
    expect(back.headers.get("etag")).toBe(PINNED_HEAD.slice(0, 7));
    expect(serviceProcesses.started).toContainEqual({ key: probe, cwd: pinned });
    // Nothing to let go of a second time.
    expect((await client.extensions.devClear({ id: ID })).cleared).toBe(false);
});

test("from an isolated conversation, its own copy of the checkout is the one run", async () => {
    const { workspace, historyRoot, app } = await setup();
    await checkoutAt(join(workspace.root, "extensions", "maintenance"));
    const own = join(worktreesRootOf(historyRoot), "conv-1", "extensions", "maintenance");
    await checkoutAt(own);
    const client = clientAs(app, "conv-1");

    expect((await client.extensions.devSet({ id: "maintenance" })).dev).toMatchObject({ path: "extensions/maintenance", conversation: "conv-1" });
    expect((await readExtensionDev(workspace.root))[ID]).toMatchObject({ path: own, conversation: "conv-1" });

    // A /work path from that conversation's shell names its own copy too.
    await clientAs(app, "conv-1").extensions.devClear({ id: ID });
    await client.extensions.devSet({ id: ID, path: join(workspace.root, "extensions", "maintenance") });
    expect((await readExtensionDev(workspace.root))[ID]?.path).toBe(own);

    const listed = await client.extensions.devList();
    expect(listed.extensions).toEqual([
        {
            id: ID,
            name: "intentic.maintenance",
            commit: PINNED_HEAD,
            dev: expect.objectContaining({ path: "extensions/maintenance", conversation: "conv-1" }),
            checkout: { path: "extensions/maintenance", conversation: "conv-1" },
        },
    ]);
});

test("a conversation that holds an install's dev checkout is not replaced, reloaded or cleared by another", async () => {
    const { workspace, historyRoot, app, client } = await setup();
    const ownA = join(worktreesRootOf(historyRoot), "conv-a", "extensions", "maintenance");
    const ownB = join(worktreesRootOf(historyRoot), "conv-b", "extensions", "maintenance");
    await checkoutAt(ownA);
    await checkoutAt(ownB);
    const a = clientAs(app, "conv-a");
    const b = clientAs(app, "conv-b");
    await a.extensions.devSet({ id: ID });

    for (const attempt of [() => b.extensions.devSet({ id: ID }), () => b.extensions.devReload({ id: ID }), () => b.extensions.devClear({ id: ID })]) {
        await attempt().then(
            () => {
                throw new Error("another conversation changed a checkout it does not hold");
            },
            (error: Error & { code?: string }) => {
                expect(error.code).toBe("PRECONDITION_FAILED");
                expect(error.message).toContain("conv-a");
            },
        );
    }
    expect((await readExtensionDev(workspace.root))[ID]).toMatchObject({ path: ownA, conversation: "conv-a" });

    // The holder moves it freely; the owner (no conversation behind the call) can always let go; then it is free to take.
    await a.extensions.devReload({ id: ID });
    await client.extensions.devClear({ id: ID });
    expect((await b.extensions.devSet({ id: ID })).dev).toMatchObject({ conversation: "conv-b" });
});

test("with no checkout of its source, it refuses and says what to clone where", async () => {
    const { client } = await setup();
    expect(await errorCode(client.extensions.devSet({ id: "maintenance" }))).toBe("PRECONDITION_FAILED");
    await client.extensions.devSet({ id: "maintenance" }).catch((error: Error) => {
        expect(error.message).toContain(`git clone ${URL} extensions/maintenance`);
    });
    expect((await client.extensions.devList()).extensions[0]).toEqual({ id: ID, name: "intentic.maintenance", commit: PINNED_HEAD });
});

test("a checkout that is no stand-in is refused; one that only needs building is written and held", async () => {
    const { workspace, client } = await setup();
    const other = join(workspace.root, "extensions", "other");
    await checkoutAt(other, { ...MANIFEST, publisher: "acme", name: "other" });
    await client.extensions.devSet({ id: ID, path: other }).then(
        () => {
            throw new Error("a checkout of another extension was accepted");
        },
        (error: Error & { code?: string }) => {
            expect(error.code).toBe("PRECONDITION_FAILED");
            expect(error.message).toBe("extensions/other holds acme.other, not intentic.maintenance, so it keeps running its pinned version");
        },
    );
    expect(await readExtensionDev(workspace.root)).toEqual({});

    const unbuilt = join(workspace.root, "extensions", "maintenance");
    await checkoutAt(unbuilt, MANIFEST, null);
    const held = await client.extensions.devSet({ id: ID, path: "extensions/maintenance" });
    expect(held.dev.held).toContain("is not built yet");
    expect(held.dev.revision).toBeUndefined();

    // Built, then reloaded: the hold lifts, and the reload is stamped so an open app re-reads the list.
    await writeFile(join(unbuilt, "dist", "extension.js"), "export const activate = () => {};");
    const reloaded = await client.extensions.devReload({ id: "maintenance" });
    expect(reloaded.dev.held).toBeUndefined();
    expect(reloaded.dev.revision).toMatch(/^[0-9a-f]{12}$/);
    expect((await readExtensionDev(workspace.root))[ID]?.reloadedAt).toEqual(expect.any(String));
});

test("reload restarts what runs from the checkout, and is refused for an install running its pinned version", async () => {
    const { workspace, probe, serviceProcesses, client } = await setup();
    expect(await errorCode(client.extensions.devReload({ id: ID }))).toBe("PRECONDITION_FAILED");
    expect(await errorCode(client.extensions.devSet({ id: "intentic.discord" }))).toBe("NOT_FOUND");

    const checkout = join(workspace.root, "extensions", "maintenance");
    await checkoutAt(checkout);
    await client.extensions.devSet({ id: ID });
    expect(serviceProcesses.started).toEqual([{ key: probe, cwd: checkout }]);
    await client.extensions.devReload({ id: ID });
    // Already in place, restarted anyway: the build under it changed.
    expect(serviceProcesses.stopped).toEqual([probe, probe]);
    expect(serviceProcesses.started).toEqual([
        { key: probe, cwd: checkout },
        { key: probe, cwd: checkout },
    ]);
});

test("removing an install in dev mode deletes the pinned copy and the pointer, never the checkout", async () => {
    const { workspace, pinned, svc, client } = await setup();
    const checkout = join(workspace.root, "extensions", "maintenance");
    await checkoutAt(checkout);
    await client.extensions.devSet({ id: ID });

    const plan = await client.extensions.removalPlan({ id: ID });
    // The pinned copy, and the directories its process was handed when dev mode started it; never the checkout.
    expect(plan.files.map((file) => file.path)).toEqual([
        ".intentic/local/extensions/intentic-maintenance",
        ".intentic/local/runtime/extensions/intentic.maintenance",
        ".intentic/local/cache/extensions/intentic.maintenance",
    ]);
    expect(plan.keeps).toContain("the source checkout it was pointed at (extensions/maintenance) stays as it is");

    await client.extensions.remove({ id: ID });
    expect(await svc.capabilities.list()).toEqual([]);
    await expect(readFile(join(pinned, "intentic-extension.json"), "utf8")).rejects.toThrow();
    expect(JSON.parse(await readFile(join(checkout, "intentic-extension.json"), "utf8"))).toMatchObject({ name: "maintenance" });
    expect(await readExtensionDev(workspace.root)).toEqual({});
});
