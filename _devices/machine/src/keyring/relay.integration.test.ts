import type { DeviceScopes, KeyringInboxItem } from "@intentic/sandbox-contract";
import { createRouterClient, ORPCError } from "@orpc/server";
import { createHostRouter } from "../device/router.js";
import { BOX, fakeKeyring, type FakeKeyring, GRANT, KEY_A, NO_KEYRING, POINTER, STATE } from "./keyring-testing.js";
import {
    keyringCopies,
    keyringInbox,
    keyringRelease,
    keyringShares,
    keyringSyncDeliver,
    keyringSyncOutbox,
    keyringSyncState,
    keyringType,
    type KeyringLink,
} from "./relay.js";

// The keyring* procedures against a keyring that answers from a script on a real socket: what reaches the pipe, which
// sandbox it is asked for, and what a missing keyring or a refusal becomes on the contract's side.

const SANDBOX = "https://work.example.intentic.dev";

let keyring: FakeKeyring;

beforeEach(async () => {
    keyring = await fakeKeyring({
        state: () => ({ ok: true, state: STATE, setUp: true }),
        shares: () => ({ ok: true, pointers: [POINTER] }),
        release: () => ({ ok: true, sealed: BOX, asked: true }),
        type: () => ({ ok: false, code: "guard", refusal: "The focused window is notepad.exe, which is not on VPN_PASSWORD's list." }),
        inbox: () => ({ ok: true, pending: true }),
        copies: () => ({ ok: true, copies: [{ name: "API_TOKEN", sealed: BOX, updatedAt: 1 }] }),
        "sync-state": () => ({ ok: true, sync: { key: KEY_A, peers: [], revision: 3 } }),
        "sync-outbox": () => ({ ok: false, code: "locked", refusal: "The keyring is locked." }),
        "sync-deliver": () => ({ ok: true, accepted: 2 }),
    });
});

afterEach(async () => {
    await keyring.close();
});

const link = (): KeyringLink => ({ sandboxUrl: SANDBOX, address: keyring.address });
const none: KeyringLink = { sandboxUrl: SANDBOX, address: NO_KEYRING };

const item = (sandbox: string): KeyringInboxItem => ({ name: "DB_PASSWORD", sealed: BOX, mode: "while-here", kind: "password", programs: [], hosts: [], sandbox });

describe("keyringShares", () => {
    it("asks for the sandbox on this link, and answers the keyring's state beside its pointers", async () => {
        expect(await keyringShares(link())).toEqual({ keyring: STATE, pointers: [POINTER] });
        expect(keyring.requests).toContainEqual({ op: "shares", sandbox: SANDBOX });
        expect(keyring.requests).toContainEqual({ op: "state" });
    });

    it("is an empty list with a reason where no keyring answers, never a failure", async () => {
        const answer = await keyringShares(none);
        expect(answer.pointers).toEqual([]);
        expect(answer.keyring).toBeUndefined();
        expect(answer.reason).toMatch(/No keyring answers on this computer/u);
    });

    it("says a keyring that is not set up yet is not, and offers nothing from it", async () => {
        await keyring.close();
        keyring = await fakeKeyring({ state: () => ({ ok: true, state: STATE, setUp: false }), shares: () => ({ ok: true, pointers: [POINTER] }) });
        const answer = await keyringShares(link());
        expect(answer).toEqual({ pointers: [], reason: expect.stringContaining("not set up") });
    });
});

describe("keyringInbox", () => {
    it("refuses an item naming another sandbox before it reaches the keyring", async () => {
        const answer = await keyringInbox(link(), item("https://other.example.intentic.dev"));
        expect(answer).toMatchObject({ ok: false, code: "not-shared" });
        expect(keyring.requests).toEqual([]);
    });

    it("passes the sandbox's own item through, a trailing slash and a host's case notwithstanding", async () => {
        const answer = await keyringInbox(link(), item("https://WORK.example.intentic.dev/"));
        expect(answer).toEqual({ ok: true, pending: true });
        expect(keyring.requests).toEqual([{ op: "inbox", item: item("https://WORK.example.intentic.dev/") }]);
    });
});

describe("release and type", () => {
    it("carry the grant through and the keyring's answer back unchanged", async () => {
        expect(await keyringRelease(link(), GRANT)).toEqual({ ok: true, sealed: BOX, asked: true });
        expect(keyring.requests).toEqual([{ op: "release", grant: GRANT }]);
        expect(await keyringType(link(), { grant: GRANT })).toMatchObject({ ok: false, code: "guard" });
    });

    it("refuse with no-keyring where none answers", async () => {
        expect(await keyringRelease(none, GRANT)).toMatchObject({ ok: false, code: "no-keyring" });
        expect(await keyringType(none, { grant: GRANT, sealed: BOX })).toMatchObject({ ok: false, code: "no-keyring" });
    });
});

describe("the answers with no room for a refusal", () => {
    it("ask copies for this link's sandbox, and are empty where no keyring answers", async () => {
        expect(await keyringCopies(link())).toEqual({ copies: [{ name: "API_TOKEN", sealed: BOX, updatedAt: 1 }] });
        expect(keyring.requests).toEqual([{ op: "copies", sandbox: SANDBOX }]);
        expect(await keyringCopies(none)).toEqual({ copies: [] });
        expect(await keyringSyncOutbox(none)).toEqual({ items: [] });
        expect(await keyringSyncDeliver(none, { items: [] })).toEqual({ accepted: 0 });
    });

    it("say a keyring's own no as an error carrying its code, not as an empty answer", async () => {
        const failed = await keyringSyncOutbox(link()).catch((error: unknown) => error);
        expect(failed).toBeInstanceOf(ORPCError);
        expect(failed).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "The keyring is locked.", data: { code: "locked" } });
    });

    it("have nothing to give for sync state without a keyring, which is an error saying so", async () => {
        expect(await keyringSyncState(link())).toEqual({ key: KEY_A, peers: [], revision: 3 });
        await expect(keyringSyncState(none)).rejects.toMatchObject({ data: { code: "no-keyring" } });
        expect(await keyringSyncDeliver(link(), { items: [] })).toEqual({ accepted: 2 });
    });
});

describe("through the device router", () => {
    const scopes: DeviceScopes = { shell: "off", write: "off", screen: "off", control: "off", sandboxes: "off", destructive: "off", programs: "off" };

    it("names the sandbox from the link the call came in on, and the answer passes the contract's own output check", async () => {
        const client = createRouterClient(
            createHostRouter({ sandboxUrl: SANDBOX, keyringAddress: keyring.address, scopes: () => scopes, setScopes: () => undefined, log: () => undefined }),
        );
        expect(await client.keyringShares()).toEqual({ keyring: STATE, pointers: [POINTER] });
        expect(keyring.requests).toContainEqual({ op: "shares", sandbox: SANDBOX });
        expect(await client.keyringInbox(item("https://elsewhere.example"))).toMatchObject({ ok: false, code: "not-shared" });
        expect(await client.keyringRelease(GRANT)).toEqual({ ok: true, sealed: BOX, asked: true });
    });
});
