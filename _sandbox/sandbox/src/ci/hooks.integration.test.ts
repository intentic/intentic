import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { defaultGit } from "@intentic/base/git";
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
    // The plain reason leads and the vendor's JSON body stays out of it.
    expect(warning?.reason).toBe(
        `Can't register a pipeline webhook on acme/web: the connected token has no admin rights on it; creating webhooks needs admin:repo_hook ` +
            `on a classic PAT (or the "Webhooks: write" repo permission on a fine-grained token). Its runs are polled instead, so they show up a little later.`,
    );
    // The recipe, with the secret, is its own half: the route hands it to an operator and to nobody else.
    expect(warning?.recipe).toContain("https://github.com/acme/web/settings/hooks");
    expect(warning?.recipe).toContain(await services.ciStore.secret());
    expect(warning?.reason).not.toContain(await services.ciStore.secret());
});

test("no public URL means no registration attempt: just the warning, and the repository read", async () => {
    const root = await workspaceWith("https://github.com/acme/web.git");
    const services = await servicesFor(root, "");
    const calls: string[] = [];
    const fetchFn: FetchFn = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response("[]", { status: 200 });
    }) as FetchFn;

    const reconciler = createCiHookReconciler(services, fetchFn);
    await reconciler.reconcile();
    // Only the repository's own read, which main's line and the deliveries' identity come from (main-line.ts).
    expect(calls).toEqual(["https://api.github.com/repos/acme/web"]);
    expect(reconciler.warnings().get("web")?.reason).toMatch(/no public URL/i);
    expect(reconciler.warnings().get("web")?.recipe).toBeUndefined();
});

// GitHub answers a spent rate limit with the same 403 a token without admin rights gets; its headers tell them apart.
test("a rate-limited refusal says the limit is spent until its reset, not that the token lacks admin rights", async () => {
    const root = await workspaceWith("https://github.com/acme/web.git");
    const services = await servicesFor(root, "https://sandbox.example.com");
    const reset = Math.floor(Date.UTC(2030, 0, 1, 12, 30) / 1000);
    // SAFETY: the reconciler calls its transport with (url, init) only, which this answers whatever they are.
    const fetchFn: FetchFn = (async () =>
        new Response(`{"message":"API rate limit exceeded"}`, {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
        })) as FetchFn;

    const reconciler = createCiHookReconciler(services, fetchFn);
    await reconciler.reconcile();
    const reason = reconciler.warnings().get("web")?.reason ?? "";
    expect(reason).not.toContain("admin rights");
    expect(reason).toBe(
        `Can't register a pipeline webhook on acme/web: the connected token's API rate limit is spent until 2030-01-01 12:30 UTC. ` +
            `Its runs are polled instead, so they show up a little later.`,
    );
});
