import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "@intentic/testing/bun";
import { connectExtensionProcess } from "./runtime.js";
import type { AutomationFire } from "./server.js";
import type { RunSettled, SandboxActivity } from "./server-reach.js";
import { type FakeExtension, type FakeManifest, fakeExtensionApi } from "./testing.js";

// What a backend hears, holds, runs and is woken by beyond its routes (backend-reach.ts, runtime.ts), each declared under
// its manifest's `permissions`: driven through the SDK's own fake daemon, which refuses what the manifest does not
// declare as the daemon does (extensions/runtime/own.routes.ts, own-doors.ts in the sandbox).

const opened: FakeExtension[] = [];
const fake = async (options: Parameters<typeof fakeExtensionApi>[0]): Promise<FakeExtension> => {
    const made = await fakeExtensionApi(options);
    opened.push(made);
    return made;
};
afterEach(async () => {
    await Promise.all(opened.splice(0).map((each) => each.dispose()));
});

const declaring = (permissions: NonNullable<FakeManifest["permissions"]>): FakeManifest => ({ publisher: "acme", name: "maintenance", permissions });
const bare = declaring({});

describe("api.events", () => {
    test("its own conversations' runs and the sandbox's activity arrive as the daemon frames them", async () => {
        const extension = await fake({ manifest: declaring({ events: ["run", "activity"] }) });
        const runs: RunSettled[] = [];
        const activity: SandboxActivity[] = [];
        extension.api.events.onRunSettled((run) => runs.push(run));
        extension.api.events.onActivity((now) => activity.push(now));
        extension.emit({ kind: "activity", live: true });
        extension.emit({ kind: "run", conversationId: "fix-main-1", run: "r1", outcome: "failed", error: "spent", closing: "I could not finish." });
        extension.emit({ kind: "activity", live: false });
        await waitFor(() => expect(activity).toHaveLength(2));
        expect(activity).toEqual([{ live: true }, { live: false }]);
        expect(runs).toEqual([{ conversationId: "fix-main-1", run: "r1", outcome: "failed", error: "spent", closing: "I could not finish." }]);
        // The stream asked for the kinds the manifest declares, and the daemon admitted it.
        expect(extension.calls).toEqual([{ line: "GET /extension/events", admitted: true }]);
    });

    test("a listener of a kind the manifest does not declare is refused before anything is sent", async () => {
        const extension = await fake({ manifest: declaring({ events: ["run"] }) });
        expect(() => extension.api.events.onActivity(() => undefined)).toThrow(
            `extension "acme.maintenance" listened for the sandbox's activity (\`activity\`) without declaring it: declare it in permissions.events in its manifest`,
        );
        expect(extension.calls).toEqual([]);
    });

    test("the daemon refuses a stream asking for a kind the manifest does not declare", async () => {
        const extension = await fake({ manifest: declaring({ events: ["run"] }) });
        expect((await extension.api.daemon.request("/extension/events?kinds=activity")).status).toBe(403);
        const asked = await extension.api.daemon.request("/extension/events?kinds=run");
        expect(asked.status).toBe(200);
        await asked.body?.cancel();
    });
});

describe("api.work.hold", () => {
    test("a hold stands while it is held and goes when it is let go", async () => {
        const extension = await fake({ manifest: declaring({ work: true }) });
        const held = extension.api.work.hold("code-health probes");
        await waitFor(() => expect(extension.holds).toEqual(["code-health probes"]));
        held.dispose();
        await waitFor(() => expect(extension.holds).toEqual([]));
    });

    test("holding without declaring `work` throws, naming the field", async () => {
        const extension = await fake({ manifest: bare });
        expect(() => extension.api.work.hold("anything")).toThrow(/declare it in permissions\.work in its manifest/);
        expect(extension.holds).toEqual([]);
    });
});

describe("api.exec", () => {
    test("a declared class runs, and the daemon's answer comes back as it was given", async () => {
        const extension = await fake({
            manifest: declaring({ exec: ["toolchain"] }),
            exec: (command) => ({ waitedMs: 12, exitCode: 1, stdout: `ran ${command.argv.join(" ")}`, stderr: "1 finding", truncated: false }),
        });
        const result = await extension.api.exec(["knip", "--reporter", "json"], { class: "toolchain", cwd: "intentic", timeoutMs: 60_000, label: "knip" });
        expect(result).toEqual({ waitedMs: 12, exitCode: 1, stdout: "ran knip --reporter json", stderr: "1 finding", truncated: false });
        expect(extension.execs).toEqual([
            { argv: ["knip", "--reporter", "json"], class: "toolchain", cwd: "intentic", timeoutMs: 60_000, outputBytes: 1024 * 1024, label: "knip" },
        ]);
    });

    test("a class the manifest does not declare is refused before anything is sent", async () => {
        const extension = await fake({ manifest: declaring({ exec: ["toolchain"] }) });
        await expect(extension.api.exec(["ls"])).rejects.toThrow(`extension "acme.maintenance" ran a command in the command class without declaring it`);
        expect(extension.execs).toEqual([]);
    });

    test("the daemon refuses a class the manifest does not declare, asked by hand", async () => {
        const extension = await fake({ manifest: declaring({ exec: ["command"] }) });
        const body = JSON.stringify({ argv: ["tsc"], class: "toolchain", timeoutMs: 1_000, outputBytes: 1_000 });
        expect((await extension.api.daemon.request("/extension/exec", { method: "POST", body })).status).toBe(403);
    });
});

describe("api.automations.onFire", () => {
    test("a declared handler is handed its fire, and lets go of its name when disposed", async () => {
        const extension = await fake({ manifest: declaring({ fires: ["sweep"] }) });
        const fired: AutomationFire[] = [];
        const registered = extension.api.automations.onFire("sweep", (fire) => {
            fired.push(fire);
        });
        await extension.fire("sweep", { id: "f1", automationId: "maintenance-sweep", firedAt: 1_000, coalesced: 3, prompt: "Sweep the probes." });
        expect(fired).toEqual([
            { id: "f1", automationId: "maintenance-sweep", handler: "sweep", firedAt: 1_000, coalesced: 3, prompt: "Sweep the probes.", payload: undefined, observed: undefined },
        ]);
        registered.dispose();
        await expect(extension.fire("sweep")).rejects.toThrow(`"acme.maintenance" has registered no "sweep" fire handler`);
    });

    test("registering a handler the manifest does not declare throws, naming the field", async () => {
        const extension = await fake({ manifest: declaring({ fires: ["sweep"] }) });
        expect(() => extension.api.automations.onFire("nightly", () => undefined)).toThrow(
            `extension "acme.maintenance" registered the fire handler "nightly" without declaring it: declare it in permissions.fires in its manifest`,
        );
    });
});

test("a process reads its declared reach from the environment the daemon started it with", async () => {
    const root = await mkdtemp(join(tmpdir(), "process-declared-"));
    const env = {
        INTENTIC_EXTENSION_ID: "acme.maintenance",
        INTENTIC_DAEMON: "http://127.0.0.1:1",
        INTENTIC_EXTENSION_TOKEN: "t",
        INTENTIC_WORKSPACE: root,
        INTENTIC_EXTENSION_STATE: root,
        INTENTIC_EXTENSION_CACHE: root,
    };
    try {
        const undeclared = connectExtensionProcess(env);
        expect(() => undeclared.api.work.hold("probes")).toThrow(/permissions\.work/);
        undeclared.close();
        const declared = connectExtensionProcess({
            ...env,
            INTENTIC_EXTENSION_DECLARED: JSON.stringify({ events: ["activity"], work: true, exec: ["toolchain"], fires: [] }),
        });
        const held = declared.api.work.hold("probes");
        held.dispose();
        expect(() => declared.api.events.onActivity(() => undefined).dispose()).not.toThrow();
        declared.close();
        expect(() => connectExtensionProcess({ ...env, INTENTIC_EXTENSION_DECLARED: JSON.stringify({ events: ["ci"] }) })).toThrow(
            "INTENTIC_EXTENSION_DECLARED is not the JSON of a declared reach",
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
