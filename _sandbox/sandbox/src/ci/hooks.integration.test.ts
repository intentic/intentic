import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { defaultGit } from "@intentic/scaffold";
import { expect, test } from "vitest";
import { fileCapabilitiesStore } from "../capabilities/capabilities-store.js";
import { fileCiStore } from "./ci-store.js";
import { createCiHookReconciler, webhookUrlFor } from "./hooks.js";
import type { FetchFn } from "./providers.js";

const logger = { warn: () => {}, error: () => {} } as never;

const workspaceWith = async (remote: string): Promise<string> => {
    const root = mkdtempSync(join(tmpdir(), "ci-hooks-"));
    const dir = join(root, "web");
    await mkdir(dir, { recursive: true });
    await defaultGit(dir, ["init", "--quiet"]);
    await defaultGit(dir, ["remote", "add", "origin", remote]);
    return root;
};

const servicesFor = async (root: string, publicUrl: string) => {
    const capabilities = fileCapabilitiesStore(join(root, `${STATE_DIR}`, "config", "capabilities.json"));
    await capabilities.upsert({ id: "github", kind: "cli", config: { provider: "github", token: "T" } });
    return {
        workspace: { root },
        capabilities,
        ciStore: fileCiStore(join(root, `${STATE_DIR}`, "secrets", "ci.json")),
        config: { sandbox: { publicUrl } },
        logger,
    };
};

test("a reconcile pass registers the hook for every mapped repo", async () => {
    const root = await workspaceWith("https://github.com/acme/web.git");
    const services = await servicesFor(root, "https://sandbox.example.com");
    const calls: { method: string; url: string; body?: string }[] = [];
    const fetchFn: FetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url: String(input), ...(typeof init?.body === "string" ? { body: init.body } : {}) });
        return new Response(JSON.stringify([]), { status: 200 });
    }) as FetchFn;

    const reconciler = createCiHookReconciler(services, fetchFn);
    await reconciler.reconcile();
    const created = calls.find((call) => call.method === "POST");
    expect(created?.url).toBe("https://api.github.com/repos/acme/web/hooks");
    expect(created?.body).toContain(webhookUrlFor("https://sandbox.example.com", "github"));
    expect(created?.body).toContain(await services.ciStore.secret());
    expect(reconciler.warnings().size).toBe(0);
});

test("a refusal degrades to a warning carrying the scope hint and the manual recipe", async () => {
    const root = await workspaceWith("https://github.com/acme/web.git");
    const services = await servicesFor(root, "https://sandbox.example.com");
    const fetchFn: FetchFn = (async (input: RequestInfo | URL, init?: RequestInit) =>
        (init?.method ?? "GET") === "POST"
            ? new Response(`{"message":"Resource not accessible"}`, { status: 403 })
            : new Response("[]", { status: 200 })) as FetchFn;

    const reconciler = createCiHookReconciler(services, fetchFn);
    await reconciler.reconcile();
    const warning = reconciler.warnings().get("web");
    expect(warning).toContain("admin:repo_hook");
    expect(warning).toContain("https://github.com/acme/web/settings/hooks");
    expect(warning).toContain(await services.ciStore.secret());
});

test("no public URL means no registration attempt: just the warning", async () => {
    const root = await workspaceWith("https://github.com/acme/web.git");
    const services = await servicesFor(root, "");
    const calls: string[] = [];
    const fetchFn: FetchFn = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response("[]", { status: 200 });
    }) as FetchFn;

    const reconciler = createCiHookReconciler(services, fetchFn);
    await reconciler.reconcile();
    expect(calls).toEqual([]);
    expect(reconciler.warnings().get("web")).toMatch(/no public URL/i);
});
