import type { KeyringNeed } from "@intentic/sandbox-contract/schemas/keyring";
import { secretsSliceFake } from "../secrets-slice.testing.js";
import { fakeDevices, fakeKeyring, type FakeKeyring, pointerOf } from "./keyring.testing.js";
import { createKeyringNeeds, memoryKeyringNeeds } from "./keyring-needs.js";

// An agent's need, asked of the owner's computers: the first yes wins and its shares are read at once, a parked question
// ends the round, nothing fitting anywhere asks the computer used last again with its type-once box, and a parked need
// turns allowed by itself once a later read lists an entry for its place.

const quiet = { warn: () => {} };
const GITHUB = { kind: "site", host: "github.com" } as const;

const needsOf = (keyring: FakeKeyring): KeyringNeed[] =>
    // SAFETY: the fake records each procedure's own input, and keyringNeed's is a need.
    keyring.calls.filter((entry) => entry.procedure === "keyringNeed").map((entry) => entry.input as KeyringNeed);

const setup = async (keyrings: Readonly<Record<string, FakeKeyring>>) => {
    const slice = secretsSliceFake(fakeDevices(keyrings));
    await slice.keyringLink.refresh();
    const store = memoryKeyringNeeds();
    return {
        slice,
        store,
        needs: createKeyringNeeds({ link: slice.keyringLink, store, logger: quiet, now: () => 5_000 }),
    };
};

test("the first computer that says yes wins, and its new pointer is read at once", async () => {
    const rog = fakeKeyring();
    rog.need = async () => {
        rog.shares = (keys) => ({ keyring: { version: "1", locked: false, unlock: ["hello"], keys, pendingInbox: 0 }, pointers: [pointerOf("GITHUB_COM", { hosts: ["github.com"] })] });
        return { ok: true, pointer: pointerOf("GITHUB_COM", { hosts: ["github.com"] }), asked: true, saved: false };
    };
    const { needs, slice } = await setup({ rog });
    const result = await needs.request({ origin: GITHUB, detail: "push the release branch", conversationId: "c-1" });
    expect(result).toMatchObject({ state: "allowed", name: "GITHUB_COM", machine: "rog" });
    expect(needsOf(rog)).toEqual([{ origin: GITHUB, detail: "push the release branch", conversation: "c-1", purpose: "agent", typeOnce: false }]);
    expect((await slice.keyringLink.pointer("GITHUB_COM"))?.machine).toBe("rog");
    expect(await needs.all()).toMatchObject([{ state: "allowed", name: "GITHUB_COM", machine: "rog" }]);
});

test("a parked question ends the round and is remembered with its computer", async () => {
    const rog = fakeKeyring();
    const omen = fakeKeyring();
    rog.need = async () => ({ ok: false, code: "pending", refusal: "waits in Requests" });
    const { needs } = await setup({ rog, omen });
    const result = await needs.request({ origin: GITHUB, detail: "sign in" });
    expect(result).toMatchObject({ state: "pending", machine: "rog" });
    expect(result.state === "pending" ? result.message : "").toContain("Passwords on rog");
    // The answer comes back by itself (password-wake.ts), so the agent is told not to ask again.
    expect(result.state === "pending" ? result.message : "").toContain("woken when they answer");
    expect(await needs.pending()).toMatchObject([{ state: "pending", machine: "rog" }]);
});

test("nothing fitting anywhere asks the most recently active computer again with its type-once box", async () => {
    const rog = fakeKeyring();
    const omen = fakeKeyring();
    const { needs } = await setup({ rog, omen });
    const result = await needs.request({ origin: GITHUB, detail: "sign in" });
    expect(result.state).toBe("unknown");
    // Each asked once without the box, then the one used last (either here: neither has answered anyone) once with it.
    const asked = [...needsOf(rog), ...needsOf(omen)];
    expect(asked.filter((need) => !need.typeOnce)).toHaveLength(2);
    expect(asked.filter((need) => need.typeOnce)).toHaveLength(1);
});

test("a person's no is final and nobody else is asked", async () => {
    const rog = fakeKeyring();
    rog.need = async () => ({ ok: false, code: "declined", refusal: "no" });
    const { needs } = await setup({ rog });
    expect(await needs.request({ origin: GITHUB, detail: "sign in" })).toMatchObject({ state: "denied" });
    expect(needsOf(rog)).toHaveLength(1);
});

test("no computer to ask answers unknown without calling anything", async () => {
    const { needs } = await setup({});
    expect((await needs.request({ origin: GITHUB, detail: "sign in" })).state).toBe("unknown");
});

test("a second ask for the same place and conversation reuses the pending need", async () => {
    const rog = fakeKeyring();
    rog.need = async () => ({ ok: false, code: "pending", refusal: "waits" });
    const { needs } = await setup({ rog });
    const first = await needs.request({ origin: GITHUB, detail: "sign in", conversationId: "c-1" });
    const second = await needs.request({ origin: GITHUB, detail: "sign in again", conversationId: "c-1" });
    expect(first.state).toBe("pending");
    expect(second.state).toBe("pending");
    expect(second.state === "pending" ? second.id : "").toBe(first.state === "pending" ? first.id : "");
    expect(needsOf(rog)).toHaveLength(1);
});

test("a parked need turning allowed wakes its conversation", async () => {
    const rog = fakeKeyring();
    rog.need = async () => ({ ok: false, code: "pending", refusal: "waits" });
    const woken: { conversationId: string; name: string }[] = [];
    const { needs, slice } = await setup({ rog });
    const stop = needs.start(async ({ conversationId, name }) => {
        woken.push({ conversationId, name });
    });
    await needs.request({ origin: GITHUB, detail: "sign in", conversationId: "c-wake" });
    rog.shares = (keys) => ({ keyring: { version: "1", locked: false, unlock: ["hello"], keys, pendingInbox: 0 }, pointers: [pointerOf("GH", { hosts: ["github.com"] })] });
    await slice.keyringLink.refresh("rog");
    await needs.recheck("rog");
    stop();
    expect(woken).toEqual([{ conversationId: "c-wake", name: "GH" }]);
});

test("a parked need turns allowed when a later read of its computer lists an entry for its place", async () => {
    const rog = fakeKeyring();
    rog.need = async () => ({ ok: false, code: "pending", refusal: "waits" });
    const { needs, slice } = await setup({ rog });
    const stop = needs.start();
    await needs.request({ origin: GITHUB, detail: "sign in" });
    rog.shares = (keys) => ({ keyring: { version: "1", locked: false, unlock: ["hello"], keys, pendingInbox: 0 }, pointers: [pointerOf("GH", { hosts: ["*.github.com"] })] });
    await slice.keyringLink.refresh("rog");
    await needs.recheck("rog");
    stop();
    expect(await needs.pending()).toEqual([]);
    expect(await needs.all()).toMatchObject([{ state: "allowed", name: "GH" }]);
});
