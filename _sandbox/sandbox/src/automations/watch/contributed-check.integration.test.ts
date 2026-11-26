import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionApiVersion } from "@intentic/extension-api";
import { declaredReachOf } from "@intentic/extension-manifest";
import { BUILT_IN_WATCH_KINDS } from "@intentic/sandbox-contract/schemas/automations";
import { STATE_DIR } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import type { AutomationRecord } from "../automations-store.js";
import { memoryAutomationsStore } from "../automations-slice.testing.js";
import type { Services } from "../../composition.js";
import { testConfig } from "../../env.config.testing.js";
import { createBackendHostApp } from "../../extensions/backend/backend-host.js";
import { readWorkspaceFile } from "../../workspace/files/workspace-files.js";
import { checkWatchSource } from "./contributed-check.js";
import { checkCondition } from "./watch-condition.js";
import { installWatchKinds, WATCH_KINDS_EXTENSION } from "./watch-kinds.testing.js";

// A watch kind an extension declares is checked by the handler its backend serves (`api.checks.serve`), through the real
// backend host's door: what it answers is what the watch saw, a change in it is what fires a `fireOn: change` watch, and
// a stored `npm` source, in the shape the daemon checked itself before 2026-11-26, fires through it unchanged. A backend
// that is down is a check that did not pass this time; an extension that is off is one that cannot run, said as such.

const HOST_TOKEN = "host-token";
const BUNDLE = `export const activateServer = (api) => {
    api.checks.serve("npm", (check) => {
        globalThis.checkedInTest.push(check);
        if (check.params.package === "boom") throw new Error("the registry answered garbage");
        const version = globalThis.npmVersion;
        return version === undefined ? { pass: false, detail: "no published version of " + check.params.package + " yet" } : { pass: true, output: check.params.package + "@" + version };
    });
    return { deactivate: () => {} };
};
`;

declare global {
    var checkedInTest: unknown[];
    var npmVersion: string | undefined;
}

const setup = async () => {
    globalThis.checkedInTest = [];
    globalThis.npmVersion = undefined;
    const root = mkdtempSync(join(tmpdir(), "contributed-check-"));
    const extensionsDir = join(root, "extensions");
    await installWatchKinds(extensionsDir);
    const dir = join(extensionsDir, WATCH_KINDS_EXTENSION);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist/server.js"), BUNDLE);
    let host: { readonly port: number; readonly hostToken: string } | undefined;
    const automations = memoryAutomationsStore([]);
    const services = unstubbed<Services>("services", {
        config: { ...testConfig, extensionsDir, historyRoot: join(root, "history") },
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [] }),
        logger: unstubbed<Services["logger"]>("logger", { warn: () => {}, info: () => {} }),
        extensionBackend: unstubbed<Services["extensionBackend"]>("extensionBackend", {
            proxyTarget: () => host,
            status: () => ({ state: "starting", extensions: [] }),
        }),
        automations,
    });
    const startHost = async (): Promise<() => Promise<void>> => {
        const app = await createBackendHostApp({
            port: 0,
            hostToken: HOST_TOKEN,
            daemonUrl: "http://127.0.0.1:1",
            workspaceRoot: root,
            apiVersion: extensionApiVersion,
            extensions: [
                {
                    id: WATCH_KINDS_EXTENSION,
                    dir,
                    server: "dist/server.js",
                    bundle: "watches",
                    stateDir: join(root, "state"),
                    cacheDir: join(root, "cache"),
                    daemonToken: "t",
                    daemonPermissions: [],
                    declared: declaredReachOf({}),
                    watchKinds: BUILT_IN_WATCH_KINDS.map((kind) => kind.id),
                },
            ],
        });
        const server = Bun.serve({ port: 0, fetch: app.fetch });
        host = { port: server.port ?? 0, hostToken: HOST_TOKEN };
        return async () => {
            host = undefined;
            await app.drain();
            await server.stop(true);
        };
    };
    const switchOff = (): void => {
        mkdirSync(join(root, STATE_DIR, "config"), { recursive: true });
        writeFileSync(join(root, STATE_DIR, "config", "extension-enablement.json"), JSON.stringify({ [WATCH_KINDS_EXTENSION]: false }));
    };
    return { services, automations, startHost, switchOff };
};

// The automation as stored now, the record a tick hands its check.
const stored = async (automations: Services["automations"], id: string): Promise<AutomationRecord> => {
    const found = await automations.get(id);
    if (found === undefined) {
        throw new Error(`no automation ${id} was stored`);
    }
    return found;
};

// A watch on npm as the daemon stored one before the kind was contributed: the same shape, untouched.
const STORED_NPM: AutomationRecord = {
    id: "bun-ships",
    trigger: { kind: "schedule", cron: "17 */6 * * *" },
    source: { kind: "npm", package: "bun", range: ">=1.4.3" },
    target: { kind: "notify" },
    prompt: "Bun shipped.",
    enabled: true,
    runs: [],
};

test("a contributed kind's check reaches the handler its backend serves, with the source's parameters", async () => {
    const { services, startHost } = await setup();
    const stop = await startHost();
    try {
        expect(await checkWatchSource(services, { kind: "npm", package: "bun", range: ">=1.4.3" })).toEqual({ pass: false, detail: "no published version of bun yet" });
        globalThis.npmVersion = "1.4.3";
        expect(await checkWatchSource(services, { kind: "npm", package: "bun", range: ">=1.4.3" }, { automation: { id: "bun-ships" }, last: "bun@1.4.2" })).toEqual({
            pass: true,
            output: "bun@1.4.3",
        });
        expect(globalThis.checkedInTest).toEqual([
            { kind: "npm", params: { package: "bun", range: ">=1.4.3" }, reach: {} },
            { kind: "npm", params: { package: "bun", range: ">=1.4.3" }, reach: {}, last: "bun@1.4.2", automationId: "bun-ships" },
        ]);
    } finally {
        await stop();
    }
});

test("a handler that throws, or a kind its backend has not served yet, is a check that did not pass, said as such", async () => {
    const { services, startHost } = await setup();
    const stop = await startHost();
    try {
        expect(await checkWatchSource(services, { kind: "npm", package: "boom" })).toEqual({
            pass: false,
            detail: 'the check failed in acme.watches\'s backend: {"error":"the registry answered garbage"}',
        });
        // Declared, but the bundle serves no check for it: not broken, since a backend still activating says the same.
        expect(await checkWatchSource(services, { kind: "github-release", repo: "oven-sh/bun" })).toEqual({
            pass: false,
            detail: 'acme.watches\'s backend does not serve the "github-release" check yet ({"error":"the \\"acme.watches\\" backend serves no \\"github-release\\" watch kind"})',
        });
    } finally {
        await stop();
    }
});

test("a backend that is down is a check that did not pass this time, not one that never can", async () => {
    const { services } = await setup();
    expect(await checkWatchSource(services, { kind: "npm", package: "bun" })).toEqual({
        pass: false,
        detail: "acme.watches could not check it now: extension backends are starting",
    });
});

test("a stored npm watch fires through the extension's check, and a fireOn: change watch fires only when what it answers moves", async () => {
    const { services, automations, startHost } = await setup();
    const stop = await startHost();
    try {
        globalThis.npmVersion = "1.4.3";
        await automations.upsert(STORED_NPM);
        const fired = await checkCondition(services, await stored(automations, "bun-ships"), undefined);
        expect(fired).toMatchObject({ kind: "go", value: "bun@1.4.3", outside: "automation-npm" });
        expect(fired.kind === "go" ? fired.observed : undefined).toContain("bun@1.4.3");

        const following = { ...STORED_NPM, id: "bun-latest", source: { kind: "npm", package: "bun" }, fireOn: "change" as const };
        await automations.upsert(following);
        const check = async () => checkCondition(services, await stored(automations, "bun-latest"), undefined);
        expect(await check()).toEqual({ kind: "skip", detail: 'First check: noted "bun@1.4.3" to compare against from now on.' });
        expect(await check()).toEqual({ kind: "quiet", detail: 'Unchanged: still "bun@1.4.3".' });
        globalThis.npmVersion = "1.4.4";
        const moved = await check();
        expect(moved).toMatchObject({ kind: "go", value: "bun@1.4.4" });
        expect(moved.kind === "go" ? moved.observed : undefined).toMatch(/It was: [\s\S]*bun@1\.4\.3[\s\S]*It is now: [\s\S]*bun@1\.4\.4/u);
        // The handler is told what the last pass saw.
        expect(globalThis.checkedInTest.at(-1)).toMatchObject({ last: "bun@1.4.3", automationId: "bun-latest" });
    } finally {
        await stop();
    }
});

test("a watch whose kind's extension is switched off fails as broken, naming the extension, and the watch says so", async () => {
    const { services, automations, switchOff } = await setup();
    switchOff();
    await automations.upsert(STORED_NPM);
    const verdict = await checkCondition(services, await stored(automations, "bun-ships"), undefined);
    const why = 'acme.watches, which serves the "npm" watch kind, is switched off: switch it back on in Extensions, or check something else';
    expect(verdict).toEqual({ kind: "skip", detail: why, broken: true });
    expect((await automations.get("bun-ships"))?.watch?.waiting).toBe(why);
});
