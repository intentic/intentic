import { createHash } from "node:crypto";
import { WAKE_DOORS_MAX } from "@intentic/api-contract/ingress";
import { type WakeDoorSources, wakeDoorsOf, wakeRoutePath } from "./wake-doors.js";

// The doors a hosted machine sleeps with: a door for every enabled webhook automation whose fire token was handed out,
// and for every `wakes` route of an extension whose listener provider has an enabled automation behind it; only digests.

const NOW = Date.parse("2026-11-27T12:00:00Z");
const sha = (secret: string): string => createHash("sha256").update(secret).digest("hex");

type Automation = WakeDoorSources["automations"][number];
const webhook = (id: string, over: Partial<Automation> = {}): Automation => ({ id, enabled: true, trigger: { kind: "event" }, ...over });
const listening = (id: string, provider: string, over: Partial<Automation> = {}): Automation => ({
    id,
    enabled: true,
    trigger: { kind: "listener", provider },
    ...over,
});

const TELEGRAM = {
    id: "intentic.telegram",
    provider: "telegram",
    routes: [
        { path: "*/updates", automation: true as const, wakes: true as const },
        { path: "hook", wakes: true as const },
        { path: "status" },
    ],
};

const sources = (over: Partial<WakeDoorSources>): WakeDoorSources => ({
    automations: [],
    extensions: [],
    fireToken: async (id) => `token-${id}`,
    wakeSecret: async (path) => `secret-${path}`,
    now: NOW,
    ...over,
});

test("an enabled webhook automation's fire URL is a door, its token's digest the secret, never the token", async () => {
    const doors = await wakeDoorsOf(sources({ automations: [webhook("auto-1")] }));
    expect(doors).toEqual([{ path: "/automations/auto-1/fire", digest: sha("token-auto-1") }]);
    expect(JSON.stringify(doors)).not.toContain("token-auto-1");
});

test("a switched-off, expired or never-shown webhook opens nothing", async () => {
    const doors = await wakeDoorsOf(
        sources({
            automations: [webhook("off", { enabled: false }), webhook("gone", { expiresAt: NOW - 1 }), webhook("unseen"), webhook("later", { expiresAt: NOW + 1 })],
            fireToken: async (id) => (id === "unseen" ? undefined : `token-${id}`),
        }),
    );
    expect(doors.map((door) => door.path)).toEqual(["/automations/later/fire"]);
});

test("an extension's `wakes` routes open while an automation listens on its provider, one per automation for an automation's route", async () => {
    const doors = await wakeDoorsOf(
        sources({
            automations: [listening("chat-a", "telegram"), listening("chat-b", "telegram"), listening("off", "telegram", { enabled: false }), listening("x", "slack")],
            extensions: [TELEGRAM],
        }),
    );
    const paths = ["/door/intentic.telegram/chat-a/updates", "/door/intentic.telegram/chat-b/updates", "/door/intentic.telegram/hook"];
    expect(doors).toEqual(paths.map((path) => ({ path, digest: sha(`secret-${path}`) })));
});

test("no automation on its provider, or a provider it does not own, opens none of its routes", async () => {
    expect(await wakeDoorsOf(sources({ automations: [listening("x", "slack"), webhook("w")], extensions: [TELEGRAM], fireToken: async () => undefined }))).toEqual(
        [],
    );
    expect(await wakeDoorsOf(sources({ automations: [listening("chat-a", "telegram")], extensions: [{ ...TELEGRAM, provider: undefined }] }))).toEqual([]);
});

test("a route's path is the one its wake URL names, the automation encoded as one segment", () => {
    expect(wakeRoutePath("intentic.telegram", "*/updates", "chat a/b")).toBe("/door/intentic.telegram/chat%20a%2Fb/updates");
    expect(wakeRoutePath("intentic.telegram", "hook")).toBe("/door/intentic.telegram/hook");
});

test("the list is stable and held to what the platform keeps", async () => {
    const automations = Array.from({ length: WAKE_DOORS_MAX + 6 }, (_, index) => webhook(`auto-${String(index).padStart(3, "0")}`));
    const doors = await wakeDoorsOf(sources({ automations: automations.toReversed() }));
    expect(doors).toHaveLength(WAKE_DOORS_MAX);
    expect(doors[0]?.path).toBe("/automations/auto-000/fire");
});
