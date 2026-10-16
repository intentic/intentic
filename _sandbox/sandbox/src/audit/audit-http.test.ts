import type { AuditEvent } from "@intentic/sandbox-contract/schemas/audit";
import { SANDBOX_ROUTES } from "@intentic/sandbox-contract";
import { RAW_ROUTE_LIST } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import { AUDITED_CHANGES, AUDITED_READS, auditRequests, noteAudit, pathTarget } from "./audit-http.js";

const routeNames = new Set([...SANDBOX_ROUTES, ...RAW_ROUTE_LIST].map((route) => route.name));

// A name that matches no route would audit nothing, silently: a renamed route must be renamed here too.
test("every audited route name is a route this build serves", () => {
    const unknown = [...AUDITED_CHANGES.keys(), ...AUDITED_READS.keys()].filter((name) => !routeNames.has(name));
    expect(unknown).toEqual([]);
});

test("a template's parameters are read off the path", () => {
    expect(pathTarget("/agents/{id}/discard", "/agents/c-1/discard")).toBe("c-1");
    expect(pathTarget("/secrets/gates/{subject}", "/secrets/gates/GITHUB%2FTOKEN")).toBe("GITHUB/TOKEN");
    expect(pathTarget("/settings", "/settings")).toBeUndefined();
});

// A tiny app standing in for the daemon's: an identity set the way the bearer middleware sets it, the audit middleware
// above it, and routes answering what the real ones would.
const appWith = (reads: boolean, recorded: AuditEvent[], role: "owner" | "viewer" = "owner") => {
    const app = new Hono<AppEnv>();
    app.use("*", auditRequests({ record: (event) => recorded.push(event), recordsReads: () => reads }));
    app.use("*", async (c, next) => {
        c.set("identity", { email: "Ann@Example.com", role, methods: ["google"] });
        await next();
    });
    app.post("/settings", (c) => {
        noteAudit({ details: { changed: [{ key: "chatPages", from: true, to: false }] } });
        return c.json({ ok: true });
    });
    app.post("/system/session", (c) => {
        noteAudit({ skip: true });
        return c.json({ ok: true });
    });
    app.delete("/secrets/gates/:subject", (c) => (role === "owner" ? c.json({ ok: true }) : c.json({ error: "no" }, 403)));
    app.get("/workspace/file", (c) => c.json({ content: "x" }));
    app.get("/agents", (c) => c.json([]));
    return app;
};

test("a change is recorded with its actor, target and the details its handler noted", async () => {
    const recorded: AuditEvent[] = [];
    const app = appWith(false, recorded);
    await app.request("/settings", { method: "POST" });
    await app.request("/secrets/gates/GITHUB_TOKEN", { method: "DELETE" });
    expect(recorded).toEqual([
        {
            actor: { kind: "member", email: "ann@example.com", role: "owner" },
            action: "settings.change",
            details: { changed: [{ key: "chatPages", from: true, to: false }] },
        },
        { actor: { kind: "member", email: "ann@example.com", role: "owner" }, action: "secret.gate.remove", target: "GITHUB_TOKEN" },
    ]);
});

test("a refused change is recorded as refused; a skipped one and unaudited routes are not recorded", async () => {
    const recorded: AuditEvent[] = [];
    const app = appWith(false, recorded, "viewer");
    await app.request("/secrets/gates/GITHUB_TOKEN", { method: "DELETE" });
    await app.request("/system/session", { method: "POST" });
    await app.request("/agents");
    expect(recorded).toEqual([
        { actor: { kind: "member", email: "ann@example.com", role: "viewer" }, action: "secret.gate.remove", target: "GITHUB_TOKEN", outcome: "refused" },
    ]);
});

test("reads are recorded only while recordReads is on", async () => {
    const off: AuditEvent[] = [];
    await appWith(false, off).request("/workspace/file?path=notes/a.md");
    expect(off).toEqual([]);
    const on: AuditEvent[] = [];
    await appWith(true, on).request("/workspace/file?path=notes/a.md");
    expect(on).toEqual([{ actor: { kind: "member", email: "ann@example.com", role: "owner" }, action: "file.read", target: "notes/a.md" }]);
});
