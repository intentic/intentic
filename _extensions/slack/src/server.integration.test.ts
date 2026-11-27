import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type FakeExtension, type FakeManifest, fakeExtensionApi } from "@intentic/extension-api/testing";
import { waitFor } from "@intentic/testing/bun";
import { z } from "zod";
import { createAppLink, EVENTS_ROUTE, slackAppManifest } from "./app-manifest.js";
import { GATEWAY_EVENTS_PATH, SLACK_RETRY_NUM_HEADER, SLACK_SIGNATURE_HEADER, SLACK_TIMESTAMP_HEADER } from "./http.js";
import { activateServer, SETUP_FILE, type SlackBackendDeps } from "./server.js";

// The backend as the host activates it, on the SDK's fake daemon (@intentic/extension-api/testing), its public route
// reached as the daemon's door hands a call over. The gateway's loopback is a recorded fetch: what the backend handed on,
// and what the gateway answered.

const manifest: FakeManifest = JSON.parse(await readFile(new URL("../intentic-extension.json", import.meta.url), "utf8"));

const GATEWAY = "http://127.0.0.1:47123";

interface Handed {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: string;
}

let running: FakeExtension | undefined;
afterEach(async () => {
    await running?.deactivate();
    await running?.dispose();
    running = undefined;
});

// The backend over a gateway that answers `answer` (or cannot be reached, when it is an Error), published at GATEWAY
// unless `published` is false.
const start = async (options: { readonly answer?: Response | Error; readonly published?: boolean; readonly hosted?: boolean } = {}) => {
    const handed: Handed[] = [];
    const deps: SlackBackendDeps = {
        gatewayUrl: async () => (options.published === false ? undefined : GATEWAY),
        fetch: async (url, init) => {
            handed.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()), body: String(init.body) });
            if (options.answer instanceof Error) {
                throw options.answer;
            }
            return options.answer ?? new Response("", { status: 200 });
        },
        hosted: options.hosted ?? false,
    };
    running = await fakeExtensionApi({ manifest });
    await running.activate({ activateServer: (api) => activateServer(api, deps) });
    return { extension: running, handed };
};

const SLACK_HEADERS = {
    "content-type": "application/json",
    [SLACK_SIGNATURE_HEADER]: "v0=abc",
    [SLACK_TIMESTAMP_HEADER]: "1764201600",
    [SLACK_RETRY_NUM_HEADER]: "1",
};
const EVENT = `{"type":"event_callback","event_id":"Ev1","event":{"type":"message","text":"hi"}}`;

test("a call to the Request URL is handed to the gateway's loopback unread, with Slack's headers, and answered as the gateway answers", async () => {
    const { extension, handed } = await start({ answer: new Response("", { status: 200 }) });
    const answer = await extension.publicRoute(EVENTS_ROUTE, { method: "POST", headers: { ...SLACK_HEADERS, cookie: "not-for-the-gateway" }, body: EVENT });
    expect(answer.status).toBe(200);
    expect(handed).toEqual([{ url: `${GATEWAY}${GATEWAY_EVENTS_PATH}`, headers: SLACK_HEADERS, body: EVENT }]);
});

test("the gateway's refusal reaches Slack as it was given", async () => {
    const { extension } = await start({ answer: new Response("bad signature", { status: 401 }) });
    const answer = await extension.publicRoute(EVENTS_ROUTE, { method: "POST", headers: SLACK_HEADERS, body: EVENT });
    expect([answer.status, await answer.text()]).toEqual([401, "bad signature"]);
});

test("a gateway whose connection is still opening is a 503 Slack is told to retry in a minute", async () => {
    const { extension } = await start({ answer: new Response("the Slack connection is starting", { status: 503 }) });
    const answer = await extension.publicRoute(EVENTS_ROUTE, { method: "POST", headers: SLACK_HEADERS, body: EVENT });
    expect([answer.status, answer.headers.get("retry-after")]).toEqual([503, "60"]);
});

test("with no gateway running yet, an event is refused 503 so Slack sends it again in a minute", async () => {
    const { extension, handed } = await start({ published: false });
    const answer = await extension.publicRoute(EVENTS_ROUTE, { method: "POST", headers: SLACK_HEADERS, body: EVENT });
    expect([answer.status, answer.headers.get("retry-after")]).toEqual([503, "60"]);
    expect(handed).toEqual([]);
});

test("a gateway that does not answer is the same 503", async () => {
    const { extension } = await start({ answer: new Error("connect ECONNREFUSED 127.0.0.1:47123") });
    const answer = await extension.publicRoute(EVENTS_ROUTE, { method: "POST", headers: SLACK_HEADERS, body: EVENT });
    expect([answer.status, answer.headers.get("retry-after")]).toEqual([503, "60"]);
});

test("the URL check is answered with its challenge even before a gateway runs, as while the app is being created", async () => {
    const { extension } = await start({ published: false });
    const answer = await extension.publicRoute(EVENTS_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{"token":"x","challenge":"3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P","type":"url_verification"}`,
    });
    expect([answer.status, await answer.text()]).toEqual([200, "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P"]);
});

const SetupSchema = z.object({ requestUrl: z.string(), createApp: z.string() });

test("a hosted sandbox writes the Request URL and a link to an app already pointed at it, where the agent reads them", async () => {
    const { extension } = await start({ hosted: true });
    const file = join(extension.api.stateDir, SETUP_FILE);
    await waitFor(async () => expect(await readFile(file, "utf8")).toContain("requestUrl"));
    const setup = SetupSchema.parse(JSON.parse(await readFile(file, "utf8")));
    expect(extension.sleep.wakeUrls).toEqual([setup.requestUrl]);
    expect(setup.requestUrl).toBe("https://sandbox-fake.sbx.test/door/intentic.slack/events?wake=fake-wake-secret");
    expect(setup.createApp).toBe(createAppLink(slackAppManifest(setup.requestUrl)));
});

test("any other sandbox asks for no wake URL and writes nothing", async () => {
    const { extension } = await start({ hosted: false });
    await expect(readFile(join(extension.api.stateDir, SETUP_FILE), "utf8")).rejects.toThrow("ENOENT");
    expect(extension.sleep.wakeUrls).toEqual([]);
});
