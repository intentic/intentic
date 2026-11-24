import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectResolved } from "@intentic/api-contract/ingress";
import type { AccountProblem, AccountReport } from "@intentic/sandbox-contract/schemas/issues";
import { createRouteClient, type PlatformRouteCall, type RouteAnswer } from "../account-routing/route-client.js";
import { statePath } from "../state-paths.js";
import { jsonAnswer } from "../http/cli-answer.js";
import { accountOutboxOffWorkspaceStep, createAccountOutbox, type Delivery, type DropEntry, OUTBOX_KEEP_MS } from "./account-outbox.js";

// The sending half: what lands is gone, what cannot land waits and folds, what is refused for good is never retried,
// and nothing waits longer than a week.

const TARGET: ProjectResolved = {
    project: "github.com/acme/app",
    sandboxId: "bbbbbbbbbbbb",
    name: "app",
    address: "https://sandbox-bbbbbbbbbbbb.sbx.test",
    pass: "sp1.x.y",
    expiresAt: "2026-11-17T12:10:00Z",
};

const problem = (message = "GET /api/orders answered 500 for order 81231"): AccountProblem => ({ kind: "detection", message });

type Resolved = { ok: true; value: ProjectResolved } | Extract<RouteAnswer, { ok: false }>;

const harness = (answers: Delivery[], resolved: Resolved = { ok: true, value: TARGET }) => {
    let clock = 1_800_000_000_000;
    const delivered: AccountReport[] = [];
    const drops: DropEntry[] = [];
    const asked: PlatformRouteCall["input"][] = [];
    const queue = [...answers];
    // The platform's directory as routeResolve answers it; a refusal with status 0 is the relay's unreachable 502.
    const route = createRouteClient({
        call: async (call) => {
            asked.push(call.input);
            return resolved.ok ? jsonAnswer(200, { scope: "report", ...resolved.value }) : jsonAnswer(resolved.status === 0 ? 502 : resolved.status, { error: resolved.message });
        },
        now: () => clock,
    });
    const outbox = createAccountOutbox({
        dir: join(mkdtempSync(join(tmpdir(), "outbox-")), "outbox"),
        logger: { info: () => {}, warn: () => {} },
        route,
        deliver: {
            report: async (_target, body) => {
                delivered.push(body);
                return queue.shift() ?? { status: 200, id: "issue-1" };
            },
            drop: async (_target, entry) => {
                drops.push(entry);
                return queue.shift() ?? { status: 200, id: "drop-1" };
            },
        },
        now: () => clock,
    });
    return { outbox, delivered, drops, asked, advance: (ms: number) => void (clock += ms) };
};

test("a report that lands is delivered and nothing waits", async () => {
    const { outbox, delivered } = harness([{ status: 200, id: "f00d" }]);
    expect(await outbox.send("git@github.com:Acme/App.git", problem(), { conversationId: "brave-fox" })).toEqual({ state: "delivered", to: "app", id: "f00d" });
    expect(delivered[0]).toEqual({ report: problem(), times: 1, conversationId: "brave-fox" });
    expect(await outbox.list()).toHaveLength(0);
});

test("an offline sandbox keeps the report, repeats fold into a count, and the drain delivers them as one", async () => {
    const { outbox, delivered, advance } = harness([{ status: 0, error: "it did not answer" }, { status: 0, error: "it did not answer" }]);
    expect(await outbox.send("github.com/acme/app", problem())).toMatchObject({ state: "queued", to: "app", times: 1 });
    expect(await outbox.send("github.com/acme/app", problem("GET /api/orders answered 500 for order 7"))).toMatchObject({ state: "queued", times: 2 });
    expect(await outbox.list()).toHaveLength(1);
    // Not yet due: the wait grows with each try.
    await outbox.drain();
    expect(delivered).toHaveLength(2);
    advance(10 * 60_000);
    await outbox.drain();
    expect(delivered.at(-1)).toMatchObject({ times: 2 });
    expect(await outbox.list()).toHaveLength(0);
});

test("a pass refused once is resolved again before giving up the try", async () => {
    const { outbox, delivered } = harness([{ status: 401, error: "this pass is not one the platform signed for this sandbox" }, { status: 200, id: "ok" }]);
    expect(await outbox.send("github.com/acme/app", problem())).toMatchObject({ state: "delivered" });
    expect(delivered).toHaveLength(2);
});

test("a receiver too old for the door keeps the report and says to update it", async () => {
    const { outbox } = harness([{ status: 401, error: "unauthorized" }]);
    const outcome = await outbox.send("github.com/acme/app", problem());
    expect(outcome).toMatchObject({ state: "queued" });
    expect(outcome.state === "queued" ? outcome.reason : "").toContain("too old");
});

test("what is refused for good is never kept: an unclaimed project, a bad body, a name that is no repository", async () => {
    const unclaimed = harness([], { ok: false, status: 404, message: "no sandbox on your account claims github.com/acme/app" });
    expect(await unclaimed.outbox.send("github.com/acme/app", problem())).toMatchObject({ state: "refused" });
    expect(await unclaimed.outbox.list()).toHaveLength(0);
    const bad = harness([{ status: 400, error: "invalid report body" }]);
    expect(await bad.outbox.send("github.com/acme/app", problem())).toMatchObject({ state: "refused" });
    expect(await bad.outbox.list()).toHaveLength(0);
    expect(await bad.outbox.send("my app", problem())).toMatchObject({ state: "refused" });
});

test("an unreachable platform keeps the report, and a week undelivered lets it go", async () => {
    const { outbox, advance } = harness([], { ok: false, status: 0, message: "the platform could not be reached" });
    expect(await outbox.send("github.com/acme/app", problem())).toMatchObject({ state: "queued" });
    advance(OUTBOX_KEEP_MS + 1);
    await outbox.drain();
    expect(await outbox.list()).toHaveLength(0);
});

test("a brokered remote names its real upstream, so `git remote get-url origin` can be passed as is", async () => {
    const { projectOfRemote } = await import("./account-outbox.js");
    const payload = Buffer.from(JSON.stringify({ i: "github", r: 3, u: "https://github.com/", c: "birch-qzfe" })).toString("base64url");
    expect(projectOfRemote(`http://127.0.0.1:8790/${payload}.7u_nDUPPkAAvZ4kN/intentic/intentic.git`)).toBe("github.com/intentic/intentic");
    expect(projectOfRemote("git@github.com:Acme/App.git")).toBe("github.com/acme/app");
    expect(projectOfRemote("http://127.0.0.1:8790/not-json.sig/acme/app.git")).toBeUndefined();
});

test("a report names its one person to the platform, and a repeat from nobody in particular names nobody", async () => {
    const { outbox, asked } = harness([{ status: 0, error: "it did not answer" }]);
    await outbox.send("github.com/acme/app", problem(), { conversationId: "brave-fox", person: "ada@acme.test" });
    expect(asked[0]).toEqual({ scope: "report", project: "github.com/acme/app", person: "ada@acme.test" });
    await outbox.send("github.com/acme/app", problem());
    expect(asked.at(-1)).toEqual({ scope: "report", project: "github.com/acme/app" });
    expect((await outbox.list())[0]).not.toHaveProperty("person");
});

test("several sandboxes claiming the project is a refusal that names them, and nothing waits", async () => {
    const { outbox } = harness([], { ok: false, status: 409, message: "2 sandboxes you are in claim github.com/acme/app: name one with --to" });
    const outcome = await outbox.send("github.com/acme/app", problem());
    expect(outcome).toMatchObject({ state: "refused" });
    expect(await outbox.list()).toHaveLength(0);
});

test("a drop goes through its own deliverer, as its person, to the sandbox it names", async () => {
    const { outbox, drops, asked } = harness([]);
    const draft = { kind: "drop", target: "ops", person: "ada@acme.test", note: "the logs from last night" } as const;
    expect(await outbox.sendDrop("drop-a", draft)).toMatchObject({ state: "delivered", id: "drop-1" });
    expect(asked[0]).toEqual({ scope: "drop", sandbox: "ops", person: "ada@acme.test" });
    expect(drops[0]).toMatchObject({ ...draft, times: 1, attempts: 0 });
});

test("an outbox from before drops is moved off the workspace and every entry reads as a report", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "outbox-ws-"));
    const history = mkdtempSync(join(tmpdir(), "outbox-hist-"));
    const legacy = statePath(workspace, ".intentic/records/outbox/");
    mkdirSync(legacy, { recursive: true });
    const old = { project: "github.com/acme/app", report: problem(), times: 2, firstAt: 1, attempts: 1, nextAt: 2 };
    writeFileSync(join(legacy, "f00d.json"), JSON.stringify(old));
    const text = (path: string): string | undefined => {
        try {
            return readFileSync(path, "utf8");
        } catch {
            return undefined;
        }
    };
    const plan = await accountOutboxOffWorkspaceStep.plan({
        roots: { workspace, history, auth: join(workspace, "auth") },
        read: async (path) => text(path),
        list: async (dir) => readdirSync(dir),
        kind: async (path) => (text(path) !== undefined ? "file" : (() => {
            try {
                readdirSync(path);
                return "directory" as const;
            } catch {
                return undefined;
            }
        })()),
    });
    const target = join(history, "account-outbox");
    expect(plan?.writes.get(join(target, "f00d.json"))).toBe(JSON.stringify(old));
    expect(plan?.writes.has(join(legacy, "f00d.json"))).toBe(true);
    expect(plan?.writes.get(join(legacy, "f00d.json"))).toBeUndefined();
    // The planned writes, applied as the boot step would, then read through today's outbox.
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "f00d.json"), JSON.stringify(old));
    const outbox = createAccountOutbox({
        dir: target,
        logger: { info: () => {}, warn: () => {} },
        route: createRouteClient({ call: async () => jsonAnswer(502, { error: "down" }) }),
        deliver: { report: async () => ({ status: 200 }) },
    });
    expect(await outbox.list()).toEqual([{ id: "f00d", kind: "report", ...old }]);
});
