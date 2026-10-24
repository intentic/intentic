import "@intentic/testing/dom";
import { ADD_SANDBOX_HOME_PATH, addSandboxAsked, closeAddSandbox, requestAddSandbox } from "./addSandbox";

afterEach(() => closeAddSandbox());

it(`asks a signed-out reader to sign in and return to the Add sandbox dialog on home`, () => {
    const navigate = jest.fn();

    requestAddSandbox(false, navigate);

    expect(ADD_SANDBOX_HOME_PATH).toBe(`/home?add=sandbox`);
    expect(navigate).toHaveBeenCalledWith({ path: `/login`, query: { returnTo: `/home?add=sandbox` } });
    expect(addSandboxAsked.value).toBe(false);
});

it(`opens the dialog in place for a signed-in reader, including before the first sandbox`, () => {
    const navigate = jest.fn();

    requestAddSandbox(true, navigate);

    expect(addSandboxAsked.value).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
});
