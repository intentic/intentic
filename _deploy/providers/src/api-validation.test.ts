import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { authentikApi } from "./auth/authentik-api.js";
import { forgejoApi } from "./forgejo/forgejo-api.js";
import { type AlerterConfig, komodoApi } from "./komodo/komodo-api.js";
import { cloudflareApi } from "./network/cloudflare-api.js";

// Stub global fetch with a single canned response so the default adapters' response validation can be
// exercised without the network. The adapters only use response.ok/status/json()/text().
const stubFetch = (body: unknown, status = 200): void => {
    stubGlobal("fetch", async () => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    }));
};

afterEach(() => {
    unstubAllGlobals();
});

const creds = { baseUrl: "https://git.example.com", user: "admin", password: "pw", owner: "admin", name: "my-app" };

test("forgejo findRepo parses a well-formed repo response", async () => {
    stubFetch({ clone_url: "https://git.example.com/admin/my-app.git", ssh_url: "git@git.example.com:admin/my-app.git", extra: "ignored" });
    expect(await forgejoApi.findRepo(creds)).toEqual({
        cloneUrl: "https://git.example.com/admin/my-app.git",
        sshUrl: "git@git.example.com:admin/my-app.git",
    });
});

test("forgejo findRepo throws a boundary error when the response is the wrong shape", async () => {
    stubFetch({ clone_url: 123 });
    await expect(forgejoApi.findRepo(creds)).rejects.toThrow(/returned an unexpected response/);
});

test("cloudflare getZone parses a well-formed envelope", async () => {
    stubFetch({ success: true, errors: [], result: [{ id: "zone-1", account: { id: "acct-1" } }] });
    expect(await cloudflareApi.getZone({ apiToken: "t", zone: "example.com" })).toEqual({ id: "zone-1", accountId: "acct-1" });
});

test("cloudflare getZone throws a boundary error when the result item lacks an id", async () => {
    stubFetch({ success: true, errors: [], result: [{}] });
    await expect(cloudflareApi.getZone({ apiToken: "t", zone: "example.com" })).rejects.toThrow(/returned an unexpected response/);
});

test("cloudflare listZones parses the zone list with each zone's account", async () => {
    stubFetch({
        success: true,
        errors: [],
        result: [{ id: "zone-1", name: "example.com", account: { id: "acct-1" } }],
        result_info: { total_pages: 1 },
    });
    expect(await cloudflareApi.listZones({ apiToken: "t" })).toEqual([{ id: "zone-1", name: "example.com", accountId: "acct-1" }]);
});

test("cloudflare tolerates a result_info without total_pages on a non-paginated call", async () => {
    // Real cfd_tunnel / dns_records list responses carry a result_info that omits total_pages; the shared
    // success envelope must not reject them: only listZones reads total_pages.
    stubFetch({ success: true, errors: [], result: [{ id: "tunnel-1" }], result_info: { count: 1, page: 1, per_page: 50, total_count: 1 } });
    expect(await cloudflareApi.findTunnel({ accountId: "a", apiToken: "t", name: "intentic-host" })).toEqual({ id: "tunnel-1" });
});

test("cloudflare surfaces an API error envelope (success:false) as a failed call", async () => {
    stubFetch({ success: false, errors: [{ code: 1003, message: "invalid zone" }], result: null });
    await expect(cloudflareApi.getZone({ apiToken: "t", zone: "example.com" })).rejects.toThrow(/failed.*invalid zone/);
});

test("komodo getAlerter parses a well-formed alerter config", async () => {
    const config: AlerterConfig = {
        enabled: true,
        endpoint: { type: "Discord", params: { url: "https://discord.test/wh" } },
        alert_types: ["DeploymentStateChange"],
        resources: [],
        except_resources: [],
    };
    stubFetch({ config });
    expect(await komodoApi.getAlerter({ baseUrl: "https://deploy.example.com", jwt: "j", id: "a1" })).toEqual(config);
});

test("komodo getAlerter throws a boundary error when the alerter config is malformed", async () => {
    stubFetch({ config: { enabled: "yes" } });
    await expect(komodoApi.getAlerter({ baseUrl: "https://deploy.example.com", jwt: "j", id: "a1" })).rejects.toThrow(
        /returned an unexpected response/,
    );
});

test("komodo getDeployment parses the authored config slice", async () => {
    const config = {
        server_id: "host",
        branch: "main",
        image: { type: "Build", params: { build: "my-app" } },
        environment: [{ variable: "DATABASE_URL", value: "postgres://x" }],
        ports: ["20000:20000"],
    };
    stubFetch({ config });
    // The read validates the env it diffs on and passes the rest (server_id/image/branch/ports) through.
    expect(await komodoApi.getDeployment({ baseUrl: "https://deploy.example.com", jwt: "j", deployment: "my-app.production" })).toEqual(config);
});

test("komodo getDeployment parses Komodo's real string env form", async () => {
    stubFetch({ config: { server_id: "host", environment: "PORT = 27748\n" } });
    const result = await komodoApi.getDeployment({ baseUrl: "https://deploy.example.com", jwt: "j", deployment: "my-app.production" });
    expect(result.environment).toBe("PORT = 27748\n");
});

test("komodo getDeployment throws a boundary error when the config is malformed", async () => {
    stubFetch({ config: { server_id: "host", environment: 7 } });
    await expect(komodoApi.getDeployment({ baseUrl: "https://deploy.example.com", jwt: "j", deployment: "my-app.production" })).rejects.toThrow(
        /returned an unexpected response/,
    );
});

// Answers each authentik call by method + path, recording the order, so deleteClient's two deletes can differ.
const stubAuthentik = (answers: Readonly<Record<string, { readonly status: number; readonly body?: unknown }>>): string[] => {
    const calls: string[] = [];
    stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        const call = `${init?.method ?? "GET"} ${url.replace("https://auth.example.com/api/v3", "")}`;
        calls.push(call);
        const answer = answers[call];
        if (answer === undefined) {
            throw new Error(`unstubbed authentik call: ${call}`);
        }
        return {
            ok: answer.status >= 200 && answer.status < 300,
            status: answer.status,
            json: async () => answer.body,
            text: async () => JSON.stringify(answer.body ?? ""),
        };
    });
    return calls;
};

const authentik = { baseUrl: "https://auth.example.com", token: "t", slug: "my-app" };

test("authentik deleteClient treats an already-gone application and provider as deleted", async () => {
    const calls = stubAuthentik({
        "DELETE /core/applications/my-app/": { status: 404, body: { detail: "Not found." } },
        "GET /providers/oauth2/?name=my-app": { status: 200, body: { results: [{ pk: 7 }] } },
        "DELETE /providers/oauth2/7/": { status: 404, body: { detail: "Not found." } },
    });
    await authentikApi.deleteClient(authentik);
    expect(calls).toEqual(["DELETE /core/applications/my-app/", "GET /providers/oauth2/?name=my-app", "DELETE /providers/oauth2/7/"]);
});

test("authentik deleteClient fails on a rejected application delete instead of reporting the client removed", async () => {
    const calls = stubAuthentik({ "DELETE /core/applications/my-app/": { status: 403, body: { detail: "forbidden" } } });
    await expect(authentikApi.deleteClient(authentik)).rejects.toThrow('authentik DELETE /core/applications/my-app/ failed (403): {"detail":"forbidden"}');
    expect(calls).toEqual(["DELETE /core/applications/my-app/"]);
});

test("authentik deleteClient fails on a rejected provider delete", async () => {
    stubAuthentik({
        "DELETE /core/applications/my-app/": { status: 204 },
        "GET /providers/oauth2/?name=my-app": { status: 200, body: { results: [{ pk: 7 }] } },
        "DELETE /providers/oauth2/7/": { status: 500, body: "boom" },
    });
    await expect(authentikApi.deleteClient(authentik)).rejects.toThrow('authentik DELETE /providers/oauth2/7/ failed (500): "boom"');
});
