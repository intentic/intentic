import type { PushChannel } from "@intentic/sandbox-contract/schemas/push";
import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { createPushRoutes } from "./push.routes.js";

/* A device is filed under the member whose verified session registered it, which is what lets a notification skip
 * only the devices of the member who is looking (push.ts). The daemon knows the caller; the device never says. */

const laptop: PushChannel = { kind: "webpush", endpoint: "https://push.example/laptop", keys: { p256dh: "p256dh-key", auth: "auth-secret" } };

// The request as the middleware hands it on: with no verified caller (loopback, no sign-in), or with the one it verified.
const anonymous: OrpcContext = { headers: new Headers(), method: "POST", url: "/push/subscribe" };
const signedIn = (email: string): OrpcContext => ({ ...anonymous, identity: { email, role: "collaborator", methods: ["google"] } });

const routes = () => {
    const filed: { readonly channel: PushChannel; readonly member: string | undefined }[] = [];
    const push = createPushRoutes({
        push: unstubbed<Services["push"]>("push", {
            add: async (channel, member) => {
                filed.push({ channel, member });
            },
        }),
        pushSender: unstubbed<Services["pushSender"]>("pushSender", {}),
    });
    return { push, filed };
};

test("a device is filed under the verified caller, whatever member the device itself names", async () => {
    const { push, filed } = routes();
    await call(push.subscribe, laptop, { context: signedIn("ada@example.com") });
    // A member on the body is not the device's to claim: the contract drops it before the route sees it.
    const claiming = { ...laptop, member: "mallory@example.com" };
    await call(push.subscribe, claiming, { context: signedIn("ada@example.com") });
    expect(filed).toEqual([
        { channel: laptop, member: "ada@example.com" },
        { channel: laptop, member: "ada@example.com" },
    ]);
});

test("a caller with no member identity files a device under nobody, which keeps the sandbox-wide rule", async () => {
    const { push, filed } = routes();
    await call(push.subscribe, laptop, { context: anonymous });
    expect(filed).toEqual([{ channel: laptop, member: undefined }]);
});

// The words of a notification are the caller's to read back only when it was sent to their own devices; every other
// asking (someone else's, never sent, no longer kept, no member identity) is the same not-found, so asking reveals nothing.
test("a notification's words are read back only by a member it was sent to", async () => {
    const sentToAda = { title: "Turn finished", body: "Fix the login redirect", url: "/?conversation=c1", tag: "turn-c1", sentAt: "2026-10-19T12:00:00.000Z" };
    const asked: { readonly tag: string; readonly member: string }[] = [];
    const push = createPushRoutes({
        push: unstubbed<Services["push"]>("push", {}),
        pushSender: unstubbed<Services["pushSender"]>("pushSender", {
            sent: (tag, member) => {
                asked.push({ tag, member });
                return tag === "turn-c1" && member === "ada@example.com" ? sentToAda : undefined;
            },
        }),
    });
    await expect(call(push.notification, { tag: "turn-c1" }, { context: signedIn("ada@example.com") })).resolves.toEqual(sentToAda);
    await expect(call(push.notification, { tag: "turn-c1" }, { context: signedIn("bob@example.com") })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call(push.notification, { tag: "turn-c2" }, { context: signedIn("ada@example.com") })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call(push.notification, { tag: "turn-c1" }, { context: anonymous })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A caller with no member identity is never even looked up.
    expect(asked).toEqual([
        { tag: "turn-c1", member: "ada@example.com" },
        { tag: "turn-c1", member: "bob@example.com" },
        { tag: "turn-c2", member: "ada@example.com" },
    ]);
});
