import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { createRunGrants } from "../device-door.js";
import { deviceDoorRawRoutes, type DeviceDoorServices, refusalFor, type DoorServices } from "../device-door.routes.js";
import { provenTurnHeaders } from "../../seams/workload-stamp.testing.js";

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
    expect((await ask(door, "rog", provenTurnHeaders("conv-a"))).status).toBe(200);
    expect(await ask(door, "omen", provenTurnHeaders("conv-a"))).toMatchObject({ status: 403, error: expect.stringContaining(`"omen"`) });
    expect((await ask(door, "rog", provenTurnHeaders("conv-b"))).status).toBe(403);
});

// Every turn presents the same agent token, so the name alone once let conv-b act as conv-a, which mounts rog.
test("a conversation named without its turn's proof is refused, even one that mounts the computer", async () => {
    const door = services();
    const refusal = { status: 403, error: expect.stringContaining('names conversation "conv-a" without the proof its turn carries') };
    expect(await ask(door, "rog", { "x-intentic-conversation": "conv-a" })).toEqual(refusal);
    expect(await ask(door, "rog", { "x-intentic-conversation": "conv-a", "x-intentic-turn-proof": provenTurnHeaders("conv-b")["x-intentic-turn-proof"] })).toEqual(refusal);
});

// An agent that unset its stamp makes the same call as a shell naming none; the one live turn is not read into it.
test("a shell naming no conversation is refused without asking which turns are live", async () => {
    // Any read of the live turns throws, naming what it reached for.
    const door: DoorServices = { ...services(), conversations: unstubbed<Services["conversations"]>("conversations", {}) };
    expect(await ask(door, "rog", {})).toEqual({ status: 400, error: "no conversation named: run this from an agent's shell, or from a run started in the editor" });
});

test("a run from the editor reaches its own computer by its grant, and a grant decides alone when it is sent", async () => {
    const grants = createRunGrants();
    const door = services(grants);
    const grant = grants.mint("omen");
    expect((await ask(door, "omen", { "x-intentic-run-grant": grant })).status).toBe(200);
    // A grant for one computer is not a key to another, even with a conversation that mounts it beside it.
    expect((await ask(door, "rog", { "x-intentic-run-grant": grant, "x-intentic-conversation": "conv-a" })).status).toBe(403);
});

// `devices exec` writes for the computer's own shell and keeps its mirror in the folders it allows (bin/devices-exec.mjs).
test("a computer's facts reach an agent's shell by the same rule, only the part a command writes for, and only while it is connected", async () => {
    const facts = {
        os: "Microsoft Windows 11 Home",
        arch: "x64",
        shell: "powershell",
        home: "C:\\Users\\me",
        roots: ["C:\\Users\\me"],
        wslDistros: ["archlinux"],
        links: { total: 3, unreachable: 1 },
        features: ["file-copy"],
    };
    let connected = true;
    // SAFETY: the facts route reads only the door's rule and the hub's state and online answers.
    const door = { ...services(), hostHub: { state: () => ({ online: connected, facts }), online: () => connected }, deviceTunnels: {} } as unknown as DeviceDoorServices;
    const app = new Hono<AppEnv>();
    app.get("/devices/:name/facts", deviceDoorRawRoutes(door)["GET /devices/{name}/facts"]);
    const asked = async (device: string): Promise<{ status: number; body: unknown }> => {
        const response = await app.request(`/devices/${device}/facts`, { headers: provenTurnHeaders("conv-a") });
        return { status: response.status, body: await response.json() };
    };
    expect(await asked("rog")).toEqual({
        status: 200,
        body: { device: "rog", os: "Microsoft Windows 11 Home", arch: "x64", shell: "powershell", home: "C:\\Users\\me", roots: ["C:\\Users\\me"], wslDistros: ["archlinux"] },
    });
    expect((await asked("omen")).status).toBe(403);
    connected = false;
    expect(await asked("rog")).toEqual({ status: 409, body: { error: expect.stringContaining("not connected right now") } });
});
