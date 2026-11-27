import { readFile } from "node:fs/promises";
import { type FakeExtension, type FakeManifest, fakeExtensionApi } from "@intentic/extension-api/testing";
import { waitFor } from "@intentic/testing/bun";
import { ALLOWED_UPDATES } from "./client.js";
import { activateServer } from "./server.js";
import { ParkedSchema, parkBeforeSleep, SECRET_TOKEN_HEADER, WAKE_ROUTE, wakeWebhooks, webhookSecret } from "./wake.js";

// The wake door (server.ts) and the before-sleep hook (wake.ts) on the SDK's fake daemon, which hands out wake URLs and
// tells before-sleep watches as the daemon does. The door dispatches nothing: a delivery from one of this sandbox's bots
// is refused 503, so Telegram keeps it for the gateway's poll.

// SAFETY: the extension's own manifest, read for who it is, its listener and its public routes.
const manifest = JSON.parse(await readFile(new URL("../intentic-extension.json", import.meta.url), "utf8")) as FakeManifest;

const TOKEN = "123456789:AAH-first-secret-part";
const OTHER = "987654321:BBX-second-secret-part";

const opened: FakeExtension[] = [];
afterEach(async () => {
    await Promise.all(opened.splice(0).map((each) => each.dispose()));
});

const withCards = async (tokens: readonly string[]): Promise<FakeExtension> => {
    const extension = await fakeExtensionApi({
        manifest,
        daemon: (request) =>
            new URL(request.url).pathname === "/listeners/telegram/state"
                ? Response.json({ automations: [], connectors: tokens.map((botToken, index) => ({ id: `telegram-${index}`, config: { provider: "telegram", botToken } })) })
                : undefined,
    });
    opened.push(extension);
    return extension;
};

const deliver = (extension: FakeExtension, secret?: string): Promise<Response> =>
    extension.publicRoute(`/${WAKE_ROUTE}`, {
        method: "POST",
        headers: secret === undefined ? { "content-type": "application/json" } : { "content-type": "application/json", [SECRET_TOKEN_HEADER]: secret },
        body: JSON.stringify({ update_id: 7, message: { message_id: 1, chat: { id: 5, type: "private" }, date: 1, text: "hi" } }),
    });

describe("the wake door", () => {
    test("refuses a delivery from one of this sandbox's bots 503, so Telegram keeps it for the poll, and dispatches nothing", async () => {
        const extension = await withCards([OTHER, TOKEN]);
        await extension.activate({ activateServer });
        const answered = await deliver(extension, webhookSecret(TOKEN));
        expect(answered.status).toBe(503);
        expect(answered.headers.get("retry-after")).toBe("10");
        expect(extension.calls.map(({ line }) => line).filter((line) => line.includes("/listeners/"))).toEqual(["GET /listeners/telegram/state"]);
    });

    test("refuses a secret the bot's token did not make, and a call with no secret at all", async () => {
        const extension = await withCards([TOKEN]);
        await extension.activate({ activateServer });
        expect((await deliver(extension, webhookSecret("123456789:a-replaced-token"))).status).toBe(403);
        expect((await deliver(extension, "123456789_guessed")).status).toBe(403);
        expect((await deliver(extension)).status).toBe(401);
    });

    test("tells Telegram to stop calling for a bot no card here holds any more", async () => {
        const extension = await withCards([TOKEN]);
        await extension.activate({ activateServer });
        const answered = await deliver(extension, webhookSecret("555:a-removed-bot"));
        expect(answered.status).toBe(200);
        expect(await answered.json()).toEqual({ method: "deleteWebhook" });
    });

    test("asks Telegram to try again when it cannot tell which bots it serves", async () => {
        const extension = await fakeExtensionApi({ manifest, daemon: () => new Response("down", { status: 502 }) });
        opened.push(extension);
        await extension.activate({ activateServer });
        expect((await deliver(extension, webhookSecret(TOKEN))).status).toBe(503);
    });
});

test("before a hosted sleep each polled bot is pointed at the wake URL, and the next start deletes only that webhook", async () => {
    const extension = await withCards([TOKEN]);
    const quiet = { info: () => undefined, warn: () => undefined };
    const parked = () => extension.api.document("wake-webhooks.json", { parse: (raw) => ParkedSchema.safeParse(raw).data, fallback: () => ({}) });
    const sent: { readonly method: string; readonly body: object | undefined }[] = [];
    const webhook = { url: "" };
    const call = async <T>(method: string, body?: object): Promise<T> => {
        sent.push({ method, body });
        // SAFETY: getWebhookInfo is read as `{ url }`, and every other call here only as answered.
        return (method === "getWebhookInfo" ? { url: webhook.url } : true) as T;
    };
    const closed: string[] = [];
    const wake = wakeWebhooks({ parked: parked(), wakeUrl: () => extension.api.sleep.wakeUrl(WAKE_ROUTE), log: quiet });
    const asleep = parkBeforeSleep(extension.api.sleep, wake, { bots: () => [{ botToken: TOKEN, username: "acme_bot", call }], close: (botToken) => void closed.push(botToken) });
    await waitFor(() => expect(extension.calls.map(({ line }) => line)).toContain("POST /extension/sleep/watch"));

    expect(await extension.sleep.now()).toBe(1);
    expect(extension.sleep.wakeUrls).toEqual(["https://sandbox-fake.sbx.test/door/intentic.telegram/wake?wake=fake-wake-secret"]);
    const [url = ""] = extension.sleep.wakeUrls;
    expect(closed).toEqual([TOKEN]);
    expect(sent).toEqual([{ method: "setWebhook", body: { url, secret_token: webhookSecret(TOKEN), allowed_updates: ALLOWED_UPDATES } }]);
    expect(asleep()).toBe(true);

    // The next start, as a fresh gateway would make it, reads what this one wrote down.
    webhook.url = url;
    sent.length = 0;
    const next = wakeWebhooks({ parked: parked(), wakeUrl: () => extension.api.sleep.wakeUrl(WAKE_ROUTE), log: quiet });
    expect(await next.reclaim(TOKEN, call, false)).toBe(true);
    expect(sent).toEqual([
        { method: "getWebhookInfo", body: undefined },
        { method: "deleteWebhook", body: { drop_pending_updates: false } },
    ]);
    // Cleared once: a later start asks nothing.
    sent.length = 0;
    expect(await next.reclaim(TOKEN, call, false)).toBe(false);
    expect(sent).toEqual([]);
});
