import { Hono } from "hono";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { createRunGrants, refusalFor, type DoorServices } from "../device-door.js";

// Who may act on one of the owner's computers from a shell: an agent whose live turn mounts that computer, or a run the
// owner started from the editor, for its one computer, while it lasts.

test("a run grant lets its one computer be acted on until it is revoked or its hours run out", () => {
    let now = 1_000;
    const grants = createRunGrants(() => now);
    const grant = grants.mint("rog");
    expect(grants.allows(grant, "rog")).toBe(true);
    expect(grants.allows(grant, "omen")).toBe(false);
    expect(grants.allows("not-a-grant", "rog")).toBe(false);
    now += 4 * 60 * 60 * 1000 + 1;
    expect(grants.allows(grant, "rog")).toBe(false);
    const again = grants.mint("rog");
    grants.revoke(again);
    expect(grants.allows(again, "rog")).toBe(false);
});

const services = (grants = createRunGrants()): DoorServices =>
    ({
        conversations: { live: () => [] } as unknown as Services["conversations"],
        turnMounts: { reaches: (conversation: string, target: { id: string }) => conversation === "conv-a" && target.id === "rog" },
        hostHub: {},
        runGrants: grants,
    }) as unknown as DoorServices;

const ask = async (door: DoorServices, device: string, headers: Record<string, string>): Promise<{ status: number; error?: string }> => {
    const app = new Hono<AppEnv>();
    app.get("/:device", (c) => {
        const refused = refusalFor(door, c, c.req.param("device"));
        return refused === undefined ? c.json({ ok: true }) : c.json({ error: refused.error }, refused.status);
    });
    const response = await app.request(`/${device}`, { headers });
    return { status: response.status, ...((await response.json()) as { error?: string }) };
};

test("an agent's shell reaches only the computers its own live turn mounts", async () => {
    const door = services();
    expect((await ask(door, "rog", { "x-intentic-conversation": "conv-a" })).status).toBe(200);
    expect(await ask(door, "omen", { "x-intentic-conversation": "conv-a" })).toMatchObject({ status: 403, error: expect.stringContaining(`"omen"`) });
    expect((await ask(door, "rog", { "x-intentic-conversation": "conv-b" })).status).toBe(403);
});

test("a run from the editor reaches its own computer by its grant, and a grant decides alone when it is sent", async () => {
    const grants = createRunGrants();
    const door = services(grants);
    const grant = grants.mint("omen");
    expect((await ask(door, "omen", { "x-intentic-run-grant": grant })).status).toBe(200);
    // A grant for one computer is not a key to another, even with a conversation that mounts it beside it.
    expect((await ask(door, "rog", { "x-intentic-run-grant": grant, "x-intentic-conversation": "conv-a" })).status).toBe(403);
});
