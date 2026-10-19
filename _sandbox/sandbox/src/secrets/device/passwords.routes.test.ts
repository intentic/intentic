import { call } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { secretsSliceFake } from "../secrets-slice.testing.js";
import { fakeDevices, fakeKeyring, type FakeKeyring, pointerOf } from "./keyring.testing.js";
import { createPasswordRoutes } from "./passwords.routes.js";

// The sandbox's Passwords routes through their handlers: a want relays the need and answers the name, the view's list
// carries each pointer's places and this sandbox's last use, and its needs and activity are this sandbox's own.

const agent: OrpcContext = { headers: new Headers({ "x-intentic-conversation": "c-9" }), method: "POST", url: "/secrets/want" };

const setup = async (keyrings: Readonly<Record<string, FakeKeyring>>) => {
    const slice = secretsSliceFake(fakeDevices(keyrings));
    await slice.keyringLink.refresh();
    return { routes: createPasswordRoutes(slice), slice };
};

test("a want answers the name the owner allowed, and names the conversation that asked", async () => {
    const rog = fakeKeyring();
    rog.need = async () => ({ ok: true, pointer: pointerOf("GITHUB_COM", { hosts: ["github.com"] }), asked: true, saved: false });
    const { routes } = await setup({ rog });
    const result = await call(routes.want, { origin: { kind: "site", host: "github.com" }, why: "push" }, { context: agent });
    expect(result).toMatchObject({ state: "allowed", name: "GITHUB_COM", machine: "rog" });
    expect(rog.calls.find((entry) => entry.procedure === "keyringNeed")?.input).toMatchObject({ conversation: "c-9", detail: "push" });
});

test("the list carries where each password works, how this sandbox may use it, and its last use here", async () => {
    const rog = fakeKeyring([pointerOf("GITHUB_COM", { hosts: ["github.com"], mode: "each-use" }), pointerOf("VPN", { programs: ["FortiClient.exe"] })]);
    const { routes, slice } = await setup({ rog });
    await slice.secretUses.record({ name: "VPN", lane: "device", detail: "rog · FortiClient.exe", at: 42 });
    const listed = await call(routes.passwords, undefined, { context: agent });
    expect(listed.items).toEqual([
        expect.objectContaining({ name: "GITHUB_COM", title: "github.com", origins: [{ kind: "site", host: "github.com" }], machine: "rog", mode: "each-use", online: true }),
        expect.objectContaining({ name: "VPN", title: "FortiClient", origins: [{ kind: "program", program: "FortiClient.exe" }], lastUsedAt: 42 }),
    ]);
    expect(listed.keyrings).toEqual([expect.objectContaining({ machine: "rog", online: true, setUp: true, locked: false })]);
    const activity = await call(routes.passwordActivity, undefined, { context: agent });
    expect(activity.lines).toEqual([{ at: 42, name: "VPN", lane: "device", detail: "rog · FortiClient.exe" }]);
});

test("the needs read lists only this sandbox's needs still waiting", async () => {
    const rog = fakeKeyring();
    rog.need = async () => ({ ok: false, code: "pending", refusal: "waits" });
    const { routes } = await setup({ rog });
    await call(routes.want, { origin: { kind: "site", host: "gitlab.com" }, why: "clone" }, { context: agent });
    const { needs } = await call(routes.passwordNeeds, undefined, { context: agent });
    expect(needs).toEqual([expect.objectContaining({ state: "pending", machine: "rog", origin: { kind: "site", host: "gitlab.com" } })]);
});
