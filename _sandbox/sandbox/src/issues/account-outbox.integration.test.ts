import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectResolved } from "@intentic/api-contract/ingress";
import type { AccountProblem, AccountReport } from "@intentic/sandbox-contract/schemas/issues";
import { createAccountOutbox, type Delivery, OUTBOX_KEEP_MS, type OutboxDeps } from "./account-outbox.js";

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

const harness = (answers: Delivery[], resolved: Awaited<ReturnType<OutboxDeps["resolve"]>> = { ok: true, value: TARGET }) => {
    let clock = 1_800_000_000_000;
    const delivered: AccountReport[] = [];
    const queue = [...answers];
    const outbox = createAccountOutbox({
        dir: join(mkdtempSync(join(tmpdir(), "outbox-")), "outbox"),
        logger: { info: () => {}, warn: () => {} },
        resolve: async () => resolved,
        deliver: async (_target, body) => {
            delivered.push(body);
            return queue.shift() ?? { status: 200, id: "issue-1" };
        },
        now: () => clock,
    });
    return { outbox, delivered, advance: (ms: number) => void (clock += ms) };
};

test("a report that lands is delivered and nothing waits", async () => {
    const { outbox, delivered } = harness([{ status: 200, id: "f00d" }]);
    expect(await outbox.send("git@github.com:Acme/App.git", problem(), "brave-fox")).toEqual({ state: "delivered", to: "app", id: "f00d" });
    expect(delivered[0]).toEqual({ report: problem(), times: 1, conversationId: "brave-fox" });
    expect(await outbox.list()).toHaveLength(0);
});

test("an offline sandbox keeps the report, repeats fold into a count, and the drain delivers them as one", async () => {
    const { outbox, delivered, advance } = harness([{ status: 0, error: "it did not answer" }, { status: 0, error: "it did not answer" }]);
    expect(await outbox.send("github.com/acme/app", problem(), undefined)).toMatchObject({ state: "queued", to: "app", times: 1 });
    expect(await outbox.send("github.com/acme/app", problem("GET /api/orders answered 500 for order 7"), undefined)).toMatchObject({ state: "queued", times: 2 });
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
    expect(await outbox.send("github.com/acme/app", problem(), undefined)).toMatchObject({ state: "delivered" });
    expect(delivered).toHaveLength(2);
});

test("a receiver too old for the door keeps the report and says to update it", async () => {
    const { outbox } = harness([{ status: 401, error: "unauthorized" }]);
    const outcome = await outbox.send("github.com/acme/app", problem(), undefined);
    expect(outcome).toMatchObject({ state: "queued" });
    expect(outcome.state === "queued" ? outcome.reason : "").toContain("too old");
});

test("what is refused for good is never kept: an unclaimed project, a bad body, a name that is no repository", async () => {
    const unclaimed = harness([], { ok: false, status: 404, message: "no sandbox on your account claims github.com/acme/app" });
    expect(await unclaimed.outbox.send("github.com/acme/app", problem(), undefined)).toMatchObject({ state: "refused" });
    expect(await unclaimed.outbox.list()).toHaveLength(0);
    const bad = harness([{ status: 400, error: "invalid report body" }]);
    expect(await bad.outbox.send("github.com/acme/app", problem(), undefined)).toMatchObject({ state: "refused" });
    expect(await bad.outbox.list()).toHaveLength(0);
    expect(await bad.outbox.send("my app", problem(), undefined)).toMatchObject({ state: "refused" });
});

test("an unreachable platform keeps the report, and a week undelivered lets it go", async () => {
    const { outbox, advance } = harness([], { ok: false, status: 0, message: "the platform could not be reached" });
    expect(await outbox.send("github.com/acme/app", problem(), undefined)).toMatchObject({ state: "queued" });
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
