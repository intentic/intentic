import "@intentic/testing/dom";
import {
    classifyPasswordFields,
    detectPasswordForm,
    findUsernameNear,
    isPasswordInput,
    shouldSkipField,
} from "./password-heuristics.js";

beforeEach(() => {
    Element.prototype.getBoundingClientRect = () => ({
        width: 100,
        height: 20,
        top: 0,
        left: 0,
        right: 100,
        bottom: 20,
        x: 0,
        y: 0,
        toJSON: () => ({}),
    });
    document.body.innerHTML = "";
});

test("login form picks the username field before the password", () => {
    document.body.innerHTML = `
        <form>
            <input type="email" name="login" autocomplete="username" value="radarsu" />
            <input type="password" name="pass" autocomplete="current-password" value="secret" />
        </form>`;
    const form = detectPasswordForm(document);
    expect(form?.kind).toBe("login");
    expect(form?.username?.name).toBe("login");
    expect(form?.capturePassword.value).toBe("secret");
});

test("sign-up with two password fields is classified as signup", () => {
    document.body.innerHTML = `
        <input name="user" />
        <input type="password" autocomplete="new-password" />
        <input type="password" autocomplete="new-password" />`;
    expect(classifyPasswordFields(Array.from(document.querySelectorAll("input[type=password]")) as HTMLInputElement[])).toBe("signup");
});

test("change-password captures the new password field", () => {
    document.body.innerHTML = `
        <input type="password" autocomplete="current-password" value="old" />
        <input type="password" autocomplete="new-password" value="new-one" />`;
    const form = detectPasswordForm(document);
    expect(form?.kind).toBe("change");
    expect(form?.capturePassword.getAttribute("autocomplete")).toBe("new-password");
    expect(form?.capturePassword.value).toBe("new-one");
});

test("one-time-code and card fields are skipped", () => {
    document.body.innerHTML = `
        <input autocomplete="one-time-code" value="123456" />
        <input autocomplete="cc-number" name="card" />
        <input type="password" value="keep" />`;
    const otp = document.querySelector("input[autocomplete=one-time-code]") as HTMLInputElement;
    const card = document.querySelector("input[name=card]") as HTMLInputElement;
    expect(shouldSkipField(otp)).toBe(true);
    expect(shouldSkipField(card)).toBe(true);
    expect(isPasswordInput(document.querySelector('input[type="password"]') as HTMLInputElement)).toBe(true);
});

test("username heuristics match email and name patterns", () => {
    document.body.innerHTML = `<input id="u" name="account" /><input type="password" id="p" />`;
    const pass = document.getElementById("p") as HTMLInputElement;
    const user = findUsernameNear(pass, document);
    expect(user?.id).toBe("u");
});
