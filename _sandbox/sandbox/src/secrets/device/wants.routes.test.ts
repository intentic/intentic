import { call } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { secretsSliceFake } from "../secrets-slice.testing.js";
import { fakeDevices, fakeKeyring, type FakeKeyring, pointerOf } from "./keyring.testing.js";
import { createWantRoutes } from "./wants.routes.js";
import { provenTurnHeaders } from "../../seams/workload-stamp.testing.js";
import { errorCode } from "../../harness/route-client.testing.js";

// The sandbox's want routes through their handlers: a want relays the need and answers the name, and the wants read
// lists this sandbox's own that still wait.

const agent: OrpcContext = { headers: new Headers(provenTurnHeaders("c-9")), method: "POST", url: "/secrets/want" };

const setup = async (keyrings: Readonly<Record<string, FakeKeyring>>) => {
    const slice = secretsSliceFake(fakeDevices(keyrings));
    await slice.keyringLink.refresh();
    return { routes: createWantRoutes(slice), slice };
};

test("a want answers the name the owner allowed, and names the conversation that asked", async () => {
    const rog = fakeKeyring();
    rog.need = async () => ({ ok: true, pointer: pointerOf("GITHUB_COM", { hosts: ["github.com"] }), asked: true, saved: false });
    const { routes } = await setup({ rog });
    const result = await call(routes.want, { origin: { kind: "site", host: "github.com" }, why: "push" }, { context: agent });
    expect(result).toMatchObject({ state: "allowed", name: "GITHUB_COM", machine: "rog" });
    expect(rog.calls.find((entry) => entry.procedure === "keyringNeed")?.input).toMatchObject({ conversation: "c-9", detail: "push" });
});

// Every turn presents the same agent token: a want naming a conversation without its proof asks no computer at all.
test("a want naming a conversation without its turn's proof is refused before any computer is asked", async () => {
    const rog = fakeKeyring();
    const { routes } = await setup({ rog });
    const bare: OrpcContext = { ...agent, headers: new Headers({ "x-intentic-conversation": "c-9" }) };
    expect(await errorCode(call(routes.want, { origin: { kind: "site", host: "github.com" }, why: "push" }, { context: bare }))).toBe("FORBIDDEN");
    expect(await errorCode(call(routes.want, { origin: { kind: "site", host: "github.com" }, why: "push", conversationId: "c-other" }, { context: agent }))).toBe("FORBIDDEN");
    expect(rog.calls.filter((entry) => entry.procedure === "keyringNeed")).toEqual([]);
});

test("the wants read lists only this sandbox's wants still waiting", async () => {
    const rog = fakeKeyring();
    rog.need = async () => ({ ok: false, code: "pending", refusal: "waits" });
    const { routes } = await setup({ rog });
    await call(routes.want, { origin: { kind: "site", host: "gitlab.com" }, why: "clone" }, { context: agent });
    const { needs } = await call(routes.wants, undefined, { context: agent });
    expect(needs).toEqual([expect.objectContaining({ state: "pending", machine: "rog", origin: { kind: "site", host: "gitlab.com" } })]);
});
