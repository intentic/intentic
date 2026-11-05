import { webextPairingCode } from "@intentic/sandbox-contract/webext";
import { installBrowser } from "./browser-testing.js";
import { type Connected, connecting } from "./connecting.js";
import { CHOICE_HOLD_MS, type PairedSandbox, store } from "./store.js";

// Pressing Connect in the popup, as it happens in the person's browser (2026-11-05): the popup arms the pairing, asks
// Chrome for the sandbox's origin, and Chrome's dialog closes the popup before its request resolves. The grant arriving
// in the worker is what redeems the code, so one Allow pairs the browser; before, nothing was redeemed and the person
// had to open the popup and go through it all a second time.

const SANDBOX = "https://sandbox-1.example.dev";
const ORIGIN = `${SANDBOX}/*`;
const CODE = webextPairingCode({ url: SANDBOX, token: "pair-1", name: "intentic" });

let redeemed: PairedSandbox[];
let answer: Connected;

const flow = () =>
    connecting(async (pairing) => {
        redeemed.push(pairing);
        if (answer.ok) {
            await store.addSandbox({ ...pairing, token: "durable" });
        }
        return answer;
    });

beforeEach(() => {
    installBrowser();
    redeemed = [];
    answer = { ok: true, message: "Connected." };
});

test("Chrome's grant of the sandbox's origin redeems a pasted code, with the popup that asked already closed", async () => {
    const connect = flow();
    await connect.arm(CODE, 1_000);
    await connect.granted(["https://github.com/*"], 2_000);
    expect(redeemed).toEqual([]);

    await connect.granted([ORIGIN], 2_000);
    expect(redeemed).toEqual([{ url: SANDBOX, token: "pair-1", name: "intentic" }]);
    expect((await store.sandboxes()).map((sandbox) => sandbox.url)).toEqual([SANDBOX]);
    // A popup that outlived the dialog only collects the answer: the one-time code is not redeemed twice.
    expect(await connect.finish(SANDBOX, 2_500)).toEqual({ ok: true, message: "Connected." });
    expect(redeemed).toHaveLength(1);
});

test("the offer a sandbox's page parked is what a Connect with no code arms, and Chrome already holding the site leaves it to the popup", async () => {
    const connect = flow();
    await store.setInbox({ url: SANDBOX, token: "pair-2" });
    await connect.arm(undefined, 1_000);
    // No dialog, so no grant: the popup is still open and finishes it.
    expect(await connect.finish(SANDBOX, 1_500)).toEqual({ ok: true, message: "Connected." });
    expect(redeemed).toEqual([{ url: SANDBOX, token: "pair-2" }]);
});

test("a pairing that fails out of the popup's sight is kept on its offer, saying why, and the popup comes up on it", async () => {
    const browser = installBrowser();
    const connect = flow();
    answer = { ok: false, message: "That code has expired. Click Connect again in your sandbox for a fresh one." };
    await connect.arm(CODE, 1_000);
    await connect.granted([ORIGIN], 2_000);
    expect(await store.inbox()).toEqual({ url: SANDBOX, token: "pair-1", name: "intentic" });
    expect(await store.connectFailed()).toEqual({ url: SANDBOX, error: answer.message });
    expect(browser.calls).toContainEqual(["popup"]);
    expect(await connect.finish(SANDBOX, 2_500)).toEqual(answer);

    // Pressing Connect again starts clean.
    answer = { ok: true, message: "Connected." };
    await connect.arm(undefined, 3_000);
    expect(await store.connectFailed()).toBeUndefined();
    await connect.granted([ORIGIN], 3_500);
    expect(redeemed).toHaveLength(2);
});

test("a Connect whose dialog was turned down long ago is not redeemed by a grant made much later", async () => {
    const connect = flow();
    await connect.arm(CODE, 1_000);
    await connect.granted([ORIGIN], 1_000 + CHOICE_HOLD_MS + 1);
    expect(redeemed).toEqual([]);
});
