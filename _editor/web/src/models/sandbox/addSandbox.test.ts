import "@intentic/testing/dom";
import { ADD_SANDBOX_HOME_PATH, addSandboxAsked, addsOnHome, closeAddSandbox, requestAddSandbox, setAddSandboxWarmer, warmAddSandbox } from "./addSandbox";

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
