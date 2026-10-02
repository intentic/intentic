import type { PushNotification } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import pino from "pino";
import webpush from "web-push";
import { opt } from "../opt.js";
import { registerPresence, updatePresence } from "../system/presence.js";
import { needRaised, turnAwaiting } from "./notifications.js";
import { createPushSender } from "./push.js";
import type { PushStore, StoredChannel } from "./push-store.js";

/* Who a notification for someone away reaches. Each device belongs to the member who registered it, so it goes quiet
 * only while THAT member has a tab in use; a device registered before devices named their member cannot be matched to
 * a tab, and keeps the old rule of waiting until every tab is idle. The store's file is push.integration.test.ts's. */

// Tabs this test opened, closed after it: the presence registry is the process's own.
const leaving: (() => void)[] = [];
afterEach(() => {
    for (const leave of leaving.splice(0)) {
        leave();
    }
    jest.restoreAllMocks();
});

// A connected tab of this member's, in use unless it has gone idle.
const tab = (clientId: string, email: string, state: "in use" | "idle" = "in use"): void => {
    leaving.push(registerPresence(clientId, { email, role: "collaborator" }));
    if (state === "idle") {
        updatePresence({ email }, { clientId, idle: true });
    }
};

const device = (endpoint: string, member?: string): StoredChannel => ({
    kind: "webpush",
    endpoint,
    keys: { p256dh: "p256dh-key", auth: "auth-secret" },
    ...opt("member", member),
});

// The registered devices as the store lists them.
const storeOf = (...channels: StoredChannel[]): PushStore =>
    unstubbed<PushStore>("push", { keys: async () => ({ publicKey: "public-key", privateKey: "private-key" }), list: async () => channels });

// Every send the web-push transport was handed, by endpoint and payload; nothing leaves the process.
const stubSends = (): { readonly endpoint: string; readonly payload: string }[] => {
    const reached: { readonly endpoint: string; readonly payload: string }[] = [];
    jest.spyOn(webpush, "setVapidDetails").mockImplementation(() => undefined);
    jest.spyOn(webpush, "sendNotification").mockImplementation(async (target, payload) => {
        reached.push({ endpoint: target.endpoint, payload: String(payload) });
        return { statusCode: 201, body: "", headers: {} };
    });
    return reached;
};

const sender = (store: PushStore) => createPushSender(store, pino({ level: "silent" }));

const waiting: PushNotification = turnAwaiting("conv-1", "permission", { requestId: "p1", detail: "Allow npm install?" }, "Fix the login redirect");

test("a member who is looking is skipped on their own devices, while a member who is away still hears it", async () => {
    const reached = stubSends();
    tab("ada-tab", "ada@example.com");
    const store = storeOf(
        device("https://push.example/ada-laptop", "ada@example.com"),
        device("https://push.example/ada-phone", "ada@example.com"),
        device("https://push.example/bob", "bob@example.com"),
    );

    await expect(sender(store).notifyIfAway(waiting)).resolves.toEqual({ delivered: 1, failed: 0 });
    expect(reached).toEqual([{ endpoint: "https://push.example/bob", payload: JSON.stringify(waiting) }]);
});

test("a member whose every tab has gone idle is away; one tab still in use keeps them present", async () => {
    const reached = stubSends();
    tab("ada-tab", "ada@example.com", "idle");
    tab("bob-idle", "bob@example.com", "idle");
    tab("bob-busy", "bob@example.com");
    const store = storeOf(device("https://push.example/ada", "ada@example.com"), device("https://push.example/bob", "bob@example.com"));

    await sender(store).notifyIfAway(waiting);
    expect(reached.map(({ endpoint }) => endpoint)).toEqual(["https://push.example/ada"]);
});

test("a device's member is matched to a tab whatever the case of either address", async () => {
    const reached = stubSends();
    tab("ada-tab", "ada@example.com");
    await sender(storeOf(device("https://push.example/ada", "Ada@Example.COM"))).notifyIfAway(waiting);
    expect(reached).toEqual([]);
});

test("a device registered before devices named their member keeps the old rule: quiet while anyone at all is looking", async () => {
    const reached = stubSends();
    const store = storeOf(device("https://push.example/unnamed"), device("https://push.example/bob", "bob@example.com"));

    // Carol owns no device here; her open tab still silences the one nobody can be matched to, and not Bob's.
    tab("carol-tab", "carol@example.com");
    await expect(sender(store).notifyIfAway(waiting)).resolves.toEqual({ delivered: 1, failed: 0 });
    expect(reached.map(({ endpoint }) => endpoint)).toEqual(["https://push.example/bob"]);

    // Once every tab is idle, it hears it too.
    updatePresence({ email: "carol@example.com" }, { clientId: "carol-tab", idle: true });
    reached.splice(0);
    await expect(sender(store).notifyIfAway(waiting)).resolves.toEqual({ delivered: 2, failed: 0 });
    expect(reached.map(({ endpoint }) => endpoint)).toEqual(["https://push.example/unnamed", "https://push.example/bob"]);
});

test("a raised need goes out the same way, verbatim, to the devices of whoever is away", async () => {
    const reached = stubSends();
    tab("ada-tab", "ada@example.com");
    const need = needRaised({ id: "n1", conversationId: "conv-1", title: "a GitHub token" }, "Fix the login redirect");

    await sender(storeOf(device("https://push.example/ada", "ada@example.com"), device("https://push.example/bob", "bob@example.com"))).notifyIfAway(
        need,
    );
    expect(reached).toEqual([{ endpoint: "https://push.example/bob", payload: JSON.stringify(need) }]);
    expect(need.url).toBe("/?conversation=conv-1&need=n1");
});

test("nobody is looking with no tab open at all, and the settings page's test send reaches a device whoever is looking", async () => {
    const reached = stubSends();
    const store = storeOf(device("https://push.example/unnamed"), device("https://push.example/ada", "ada@example.com"));
    await expect(sender(store).notifyIfAway(waiting)).resolves.toEqual({ delivered: 2, failed: 0 });

    reached.splice(0);
    tab("ada-tab", "ada@example.com");
    await expect(sender(store).notify(waiting)).resolves.toEqual({ delivered: 2, failed: 0 });
    expect(reached.map(({ endpoint }) => endpoint)).toEqual(["https://push.example/unnamed", "https://push.example/ada"]);
});

// A native install's words reach Apple in plain text through the platform, so they pass the privacy shield's redaction on
// the way; a browser's are encrypted to it end to end and go as written.
test("the privacy shield's redaction reaches a native install's notification and leaves a browser's alone", async () => {
    const reached = stubSends();
    const relayed: string[] = [];
    const relay = async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        relayed.push(String(init?.body));
        return new Response(null, { status: 200 });
    };
    jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(relay, { preconnect: globalThis.fetch.preconnect }));
    const native: StoredChannel = { kind: "relay", url: "https://platform.example/push", deviceId: "phone", secret: "s" };
    const redacting = createPushSender(storeOf(device("https://push.example/a"), native), pino({ level: "silent" }), async (text) =>
        text.replace("Jan Kowalski", "‹person›"),
    );

    await redacting.notify({ title: "Jan Kowalski wrote", body: "about Jan Kowalski's invoice" });

    expect(JSON.parse(relayed[0] ?? "{}").notification).toMatchObject({ title: "‹person› wrote", body: "about ‹person›'s invoice" });
    expect(reached[0]?.payload).toContain("Jan Kowalski");
});

// A withdrawal replaces an ask only where its persistent notification showed: the device of a member who was away gets
// the replacement under the same tag, the device of a member who was looking (and so never saw the ask) gets nothing,
// and an ask that never pushed at all, or was already withdrawn, sends nothing anywhere.
test("a withdrawn ask is replaced on exactly the devices it reached, once, and never pushes where it never showed", async () => {
    const reached = stubSends();
    tab("ada-tab", "ada@example.com");
    const push = sender(storeOf(device("https://push.example/ada", "ada@example.com"), device("https://push.example/bob", "bob@example.com")));
    await push.notifyIfAway(waiting);
    reached.splice(0);

    const replacement = { title: "No longer waiting", body: "The agent is not waiting on you anymore.", tag: waiting.tag ?? "" };
    expect(await push.withdraw(replacement)).toEqual({ delivered: 1, failed: 0 });
    expect(reached.map(({ endpoint }) => endpoint)).toEqual(["https://push.example/bob"]);
    expect(JSON.parse(reached[0]?.payload ?? "{}")).toMatchObject({ tag: waiting.tag, requireInteraction: false, silent: true });

    expect(await push.withdraw(replacement)).toEqual({ delivered: 0, failed: 0 });
    expect(await push.withdraw({ ...replacement, tag: "awaiting-never-pushed" })).toEqual({ delivered: 0, failed: 0 });
    expect(reached).toHaveLength(1);
});
