import "@intentic/testing/dom";
import { LINK_HOST } from "../../app/environments/localHost";
import {
    ADD_SANDBOX_HOME_PATH,
    addSandboxAsked,
    addsOnHome,
    closeAddSandbox,
    newSandboxLink,
    requestAddSandbox,
    setAddSandboxWarmer,
    warmAddSandbox,
} from "./addSandbox";

afterEach(() => closeAddSandbox());

it(`asks a signed-out reader to sign in and return to the same ask on home`, () => {
    const navigate = jest.fn();

    requestAddSandbox(false, true, navigate);

    expect(ADD_SANDBOX_HOME_PATH).toBe(`/home?add=sandbox`);
    expect(navigate).toHaveBeenCalledWith({ path: `/login`, query: { returnTo: `/home?add=sandbox` } });
    expect(addSandboxAsked.value).toBe(false);
});

it(`makes a desktop reader's sandbox on Home, in its own tile, whatever the press was in`, () => {
    const navigate = jest.fn();

    requestAddSandbox(true, true, navigate);

    expect(navigate).toHaveBeenCalledWith(`/home?add=sandbox`);
    expect(addSandboxAsked.value).toBe(false);
});

it(`opens the dialog in place where there is no Home to make it on`, () => {
    const navigate = jest.fn();

    requestAddSandbox(true, false, navigate);

    expect(addSandboxAsked.value).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
});

it(`adds on Home on a desktop for anyone with a Home, and in the dialog on a phone or for a box's guest`, () => {
    expect(addsOnHome({ mobile: false, isGuest: false, homeOnly: false })).toBe(true);
    expect(addsOnHome({ mobile: false, isGuest: true, homeOnly: true })).toBe(true);
    expect(addsOnHome({ mobile: false, isGuest: true, homeOnly: false })).toBe(false);
    expect(addsOnHome({ mobile: true, isGuest: false, homeOnly: false })).toBe(false);
});

// The dialog's chunk is fetched before the press, so landing on Home finds it loaded rather than seconds later.
it(`warms the add's chunk through the shell's fetch, and a failed warm stays quiet`, async () => {
    warmAddSandbox();
    const load = jest.fn(() => Promise.reject(new Error(`offline`)));
    setAddSandboxWarmer(load);

    warmAddSandbox();
    await Promise.resolve();

    expect(load).toHaveBeenCalledTimes(1);
});

describe(`a link to a new sandbox`, () => {
    afterEach(() => {
        delete window.__INTENTIC_LOCAL__;
        delete window.__INTENTIC_LOCAL_HOST__;
    });

    it(`asks Home in the workspace, with the machine when one is picked`, () => {
        expect([newSandboxLink(), newSandboxLink(`hosted`)]).toEqual([`/home?add=sandbox`, { path: `/home`, query: { add: `sandbox`, machine: `hosted` } }]);
    });

    // This computer's window has no Home: a link there fell through to Files (2026-10-27, Billing's "Start a hosted sandbox").
    it(`stays in This computer's window, on its own new-sandbox page`, () => {
        window.__INTENTIC_LOCAL__ = { daemonUrl: `http://127.0.0.1:47148`, token: `t`, id: `f1`, name: `Taxes`, path: `/home/ada/Taxes` };
        window.__INTENTIC_LOCAL_HOST__ = {
            ...LINK_HOST,
            newSandbox: { offers: () => Promise.resolve({ here: true, hosted: true }), create: () => Promise.resolve({ sandboxId: `sbx` }) },
        };
        expect([newSandboxLink(), newSandboxLink(`hosted`)]).toEqual([`/sandbox-new`, { path: `/sandbox-new`, query: { on: `hosted` } }]);
    });
});
