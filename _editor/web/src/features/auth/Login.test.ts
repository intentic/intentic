// The page mints one Google credential and spends it twice: once on the platform, once (from the same cache) on
// the sandbox, replacing two separate Google prompts. These tests check that the token handed to the platform is
// the one the browser itself minted, and that every failure path falls back to the redirect rather than a dead page.
import "@intentic/testing/dom";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import * as actualVueRouter from "vue-router";
import * as actualDesktop from "../../app/environments/desktop";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { installI18n } from "@intentic/ui/i18n";

// Mounting reads matchMedia (ui) and window.env (environment.ts) at module scope; see Setup.test.ts.

const push = jest.fn();
// Where the guard that turned somebody away wrote the page they were headed to (lib/routes/signIn.ts).
const query = ref<Record<string, string>>({});
jest.mock(`vue-router`, () => ({
    ...actualVueRouter,
    useRouter: () => ({ push, replace: jest.fn() }) as never,
    useRoute: () =>
        ({
            get query() {
                return query.value;
            },
        }) as never,
}));

const signInWithGoogle = jest.fn().mockResolvedValue(undefined);
const signInWithGoogleCredential = jest.fn().mockResolvedValue(undefined);
// The emailed-code road's two platform calls (useAuth.ts), answered as each test says.
const sendEmailCode = jest.fn<(email: string) => Promise<void>>().mockResolvedValue(undefined);
const signInWithEmailCode = jest.fn<(email: string, otp: string) => Promise<void>>().mockResolvedValue(undefined);
jest.mock(`../../client/auth/useAuth`, () => ({
    useAuth: () => ({ user: ref(null), signInWithGoogle, signInWithGoogleCredential, sendEmailCode, signInWithEmailCode }),
}));
// Which ways in the platform offers: Google alone, as every platform before email sign-in, unless a test says more.
const GOOGLE_ONLY = { google: true, email: false };
const readSignInOptions = jest.fn<() => Promise<{ google: boolean; email: boolean }>>();
jest.mock(`./signInOptions`, () => ({ GOOGLE_ONLY, readSignInOptions: () => readSignInOptions() }));

const getIdToken = jest.fn<(options?: { gate?: boolean }) => Promise<string | undefined>>();
const renderButton = jest.fn<(parent: HTMLElement) => Promise<boolean>>();
// Bumped by the module each time it refuses an answer Google gave (useGoogleIdentity.refused.test.ts).
const refusedCredentials = ref(0);
jest.mock(`../../client/auth/useGoogleIdentity`, () => ({ useGoogleIdentity: () => ({ getIdToken, renderButton, refusedCredentials }) }));
// The stall's funnel event, recorded rather than sent.
const track = jest.fn();
jest.mock(`../../app/analytics`, () => ({ track, replaySessionId: () => undefined }));
// Available desktop build for this visitor; undefined is the default, overridden only where a test needs one.
const desktopInstaller = jest.fn<() => { platform: string; label: string; href: string } | undefined>(() => undefined);
// Partial, over the real module: the page reaches for whatever the desktop lane grows next, and a mock listing its
// exports by hand fails the link the day one is added.
// An ordinary browser unless a test says this is the installed app, whose sign-in is handed to the real browser.
const desktopVersion = jest.fn<() => string | undefined>(() => undefined);
const signInThroughBrowser = jest.fn();
// The app's local window on its folder, asked for by link (desktop.ts `openThisComputer`).
const openThisComputer = jest.fn();
jest.mock(`../../app/environments/desktop`, () => ({
    ...actualDesktop,
    DESKTOP_SIGN_IN_LINK: ``,
    desktopVersion: () => desktopVersion(),
    openDesktopLink: jest.fn(),
    signInThroughBrowser: () => signInThroughBrowser(),
    openThisComputer: () => openThisComputer(),
}));
jest.mock(`../../app/environments/desktopDownloads`, () => ({ desktopInstaller: () => desktopInstaller() }));

const { default: Login } = await import("./Login.vue");

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(Login) });
    app.component(`Icon`, IconStub);
    // The emailed code's "sent to" sentence slots the address in (`<i18n-t>`), which the plugin registers.
    installI18n(app);
    app.mount(el);
    // The sign-in chain is several awaits deep; a macrotask flush avoids a fixed, fragile tick count.
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
    await nextTick();
    return el;
};

// The old redirect control, found by its label; its presence is the fallback being offered.
const redirectButton = (): HTMLButtonElement | undefined =>
    [...document.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Continue with Google`));
// The road around Google's button while that button is still up, found by its label.
const googlesPageButton = (): HTMLButtonElement | undefined =>
    [...document.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Continue on Google's page`));

// A browser with FedCM, where Google's button answers in a dialog of the browser's own; most tests read that page.
// Removed again after each test, so a test that wants a browser without it only has to leave it out.
const withFedCm = (): void => {
    Object.assign(window, { IdentityCredential: {} });
};

beforeEach(() => {
    query.value = {};
    push.mockReset();
    signInWithGoogle.mockReset().mockResolvedValue(undefined);
    signInWithGoogleCredential.mockReset().mockResolvedValue(undefined);
    // Steady state: Google's button renders and yields a credential.
    renderButton.mockReset().mockResolvedValue(true);
    getIdToken.mockReset().mockResolvedValue(`google-id-token`);
    desktopInstaller.mockReset().mockReturnValue(undefined);
    desktopVersion.mockReset().mockReturnValue(undefined);
    signInThroughBrowser.mockReset();
    openThisComputer.mockReset();
    refusedCredentials.value = 0;
    track.mockReset();
    readSignInOptions.mockReset().mockResolvedValue(GOOGLE_ONLY);
    sendEmailCode.mockReset().mockResolvedValue(undefined);
    signInWithEmailCode.mockReset().mockResolvedValue(undefined);
    withFedCm();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    Reflect.deleteProperty(window, `IdentityCredential`);
});

// A browser tab has its own back button and no app to go back to.
it(`offers no way back to This computer outside the installed app`, async () => {
    const el = await mount();

    expect(el.textContent).not.toContain(`Back to This computer`);
});

it(`signs in to the platform with the token the browser minted`, async () => {
    await mount();

    // Direction is the security property: a credential this window holds goes into the platform, nothing comes back,
    // so sandbox trust never depends on the platform's honesty.
    expect(signInWithGoogleCredential).toHaveBeenCalledWith(`google-id-token`);
    expect(push).toHaveBeenCalledWith(`/`);
});

// Both exits from this page must return to where the guard sent the visitor, not hardcode `/`, or a deep link is
// lost the moment sign-in redirects home. Asserted on both paths since one pushes and the other hands it to Better
// Auth as an OAuth callback.
it(`lands on the page that asked for the sign-in`, async () => {
    query.value = { returnTo: `/sandbox/usage` };

    await mount();

    expect(push).toHaveBeenCalledWith(`/sandbox/usage`);
});

it(`brings Google's redirect back to that same page`, async () => {
    query.value = { returnTo: `/sandbox/usage` };
    renderButton.mockResolvedValue(false);
    getIdToken.mockResolvedValue(undefined);

    await mount();
    redirectButton()?.click();
    await nextTick();

    expect(signInWithGoogle).toHaveBeenCalledWith(`/sandbox/usage`);
});

// An unchecked returnTo makes this the one page users expect Google on into an open redirect; `//host` is
// protocol-relative to every URL parser.
it(`refuses a destination that leaves this origin`, async () => {
    query.value = { returnTo: `//evil.example` };

    await mount();

    expect(push).toHaveBeenCalledWith(`/`);
});

it(`asks Google without raising the shared overlay, since its own button is the gate`, async () => {
    await mount();

    expect(getIdToken).toHaveBeenCalledWith({ gate: false });
});

it(`renders Google's own button rather than the redirect`, async () => {
    getIdToken.mockReturnValue(new Promise<never>(() => {}));

    await mount();

    expect(renderButton).toHaveBeenCalledTimes(1);
    expect(redirectButton()).toBeUndefined();
});

it(`falls back to the redirect when Google's script never arrives`, async () => {
    renderButton.mockResolvedValue(false);
    getIdToken.mockResolvedValue(undefined);

    await mount();

    expect(redirectButton()).toEqual(expect.any(Object));
    expect(signInWithGoogleCredential).not.toHaveBeenCalled();
});

it(`falls back to the redirect when the platform refuses a token Google signed`, async () => {
    signInWithGoogleCredential.mockRejectedValue(new Error(`no such endpoint`));

    const el = await mount();

    // A platform refusal (older build, client-id mismatch) says nothing about whether the sandbox will refuse too, so
    // the user gets another way in instead of a dead page.
    expect(redirectButton()).toEqual(expect.any(Object));
    expect(el.textContent).toContain(`Continue with Google below instead`);
    expect(push).not.toHaveBeenCalled();
});

it(`always offers a way in that does not depend on Google's embedded button`, async () => {
    getIdToken.mockReturnValue(new Promise<never>(() => {}));

    const el = await mount();
    const escape = [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Trouble signing in`));
    escape?.click();
    await nextTick();

    // The button can fail silently (blocked frame, popup policy), indistinguishable from a page doing nothing.
    expect(escape).toEqual(expect.any(Object));
    expect(signInWithGoogle).toHaveBeenCalledTimes(1);
});

// The copy must track `desktopInstaller`: promising a pasted command to a visitor who's actually given a Download
// button (or vice versa) is checked both ways, since either case alone would pass with the value hardcoded.
it(`promises the pasted command only where there is no build to install`, async () => {
    const el = await mount();

    expect(el.textContent).toContain(`Paste one command`);
    expect(el.textContent).not.toContain(`Install the app`);
});

it(`promises the installer on a machine we ship a build for`, async () => {
    desktopInstaller.mockReturnValue({ platform: `windows`, label: `Windows`, href: `https://intentic.dev/desktop/windows` });

    const el = await mount();

    expect(el.textContent).toContain(`Install the app`);
    expect(el.textContent).not.toContain(`Paste one command`);
});

it(`leaves the page usable when the user dismisses Google`, async () => {
    getIdToken.mockResolvedValue(undefined);

    const el = await mount();

    expect(signInWithGoogleCredential).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    // A dismissal says nothing; the button the user turned away from is still there.
    expect(el.textContent).not.toContain(`Continue with Google below instead`);
});

// Without FedCM, Google's button opens a pop-up, and a blocker, tracking protection or a closed window ends it without a
// word: a reader on Firefox pressed it for thirteen minutes across four tabs, the way out set in the small print under it.
describe(`when Google's button goes nowhere`, () => {
    // Google's button as it draws itself into the page, so a press on it is one the page can see.
    const drawGoogle = async (parent: HTMLElement): Promise<boolean> => {
        const drawn = document.createElement(`div`);
        drawn.setAttribute(`role`, `button`);
        parent.append(drawn);
        return true;
    };

    beforeEach(() => {
        getIdToken.mockReturnValue(new Promise<never>(() => {}));
        renderButton.mockImplementation(drawGoogle);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    it(`offers Google's own page as a real button from the start where there is no FedCM`, async () => {
        Reflect.deleteProperty(window, `IdentityCredential`);

        const el = await mount();
        expect(googlesPageButton()?.className ?? ``).toContain(`p-button-secondary`);
        googlesPageButton()?.click();
        await nextTick();

        expect(googlesPageButton()).toEqual(expect.any(Object));
        expect(el.textContent).not.toContain(`Trouble signing in`);
        // Beside Google's button, not instead of it: that one mints one credential for the platform and the sandbox both.
        expect(renderButton).toHaveBeenCalledTimes(1);
        expect(signInWithGoogle).toHaveBeenCalledWith(`/`);
    });

    it(`says so when a press comes back without an answer, and puts Google's own page first`, async () => {
        Reflect.deleteProperty(window, `IdentityCredential`);
        const el = await mount();
        jest.useFakeTimers();
        let focused = true;
        jest.spyOn(document, `hasFocus`).mockImplementation(() => focused);

        el.querySelector(`.entry-socket-slot [role="button"]`)!.dispatchEvent(new Event(`pointerdown`, { bubbles: true }));
        // Google's pop-up comes up in front of the page, and is closed with nothing in it.
        focused = false;
        await advanceTimersByTimeAsync(5_000);
        expect(el.textContent).not.toContain(`Still waiting on Google`);
        focused = true;
        await advanceTimersByTimeAsync(25_500);
        await nextTick();

        expect(el.textContent).toContain(`Still waiting on Google?`);
        expect(el.querySelector(`[role="status"]`)?.textContent).toContain(`Still waiting on Google?`);
        // Promoted from secondary: the press that just failed is the reason to take the other road.
        expect(googlesPageButton()?.className ?? ``).toContain(`p-button`);
        expect(googlesPageButton()?.className).not.toContain(`p-button-secondary`);
        expect(track).toHaveBeenCalledWith(`sandbox_signin_gate`, expect.objectContaining({ reason: `button-stalled`, surface: `login` }));
    });

    it(`keeps the small way out where FedCM answers, until a press goes nowhere`, async () => {
        const el = await mount();

        expect(el.textContent).toContain(`Trouble signing in`);
        expect(googlesPageButton()).toBeUndefined();
    });

    // A clock set an hour wrong puts every fresh token Google mints past its expiry here. The page used to take that
    // for a dismissal: nothing said, and every later press of the same button dropped.
    it(`says why a refused answer did not sign in, and still signs in with the next one`, async () => {
        let answer: (token: string) => void = () => undefined;
        getIdToken.mockReturnValue(new Promise((resolve) => (answer = resolve)));
        const el = await mount();

        refusedCredentials.value += 1;
        await nextTick();

        expect(el.textContent).toContain(`its clock may be wrong`);
        expect(googlesPageButton()).toEqual(expect.any(Object));
        expect(signInWithGoogleCredential).not.toHaveBeenCalled();

        answer(`google-id-token`);
        await new Promise((resolve) => setTimeout(resolve));

        expect(signInWithGoogleCredential).toHaveBeenCalledWith(`google-id-token`);
        expect(push).toHaveBeenCalledWith(`/`);
    });
});

// Inside the installed app: Google's button can't work in its window, so the press hands the sign-in to the browser.
describe(`in the installed app`, () => {
    beforeEach(() => {
        desktopVersion.mockReturnValue(`1.316.0`);
        renderButton.mockResolvedValue(false);
        desktopInstaller.mockReturnValue({ platform: `linux`, label: `Linux`, href: `https://intentic.dev/desktop/linux` });
    });

    const pressing = async (label: string): Promise<void> => {
        [...document.querySelectorAll(`button`)].find((button) => button.textContent?.includes(label))?.click();
        await nextTick();
    };

    // For the two minutes Google took in the browser the window did not change, and its reader came back to it five times.
    it(`says the sign-in is waiting in the browser once pressed, and can open it again`, async () => {
        const el = await mount();
        await pressing(`Continue with Google in your browser`);

        expect(signInThroughBrowser).toHaveBeenCalledTimes(1);
        expect(el.textContent).toContain(`Finish signing in in your browser…`);
        expect(el.textContent).not.toContain(`Continue with Google in your browser`);

        await pressing(`Open it again`);
        expect(signInThroughBrowser).toHaveBeenCalledTimes(2);
    });

    it(`goes back to the button on Cancel`, async () => {
        const el = await mount();
        await pressing(`Continue with Google in your browser`);
        await pressing(`Cancel`);

        expect(el.textContent).not.toContain(`Finish signing in in your browser…`);
        expect(el.textContent).toContain(`Continue with Google in your browser`);
    });

    // The local window's "Your workspace" opens the workspace window here when it holds no session, and this screen is
    // outside the shell and its sandbox switcher: with no way back, a sign-in was the only way off it.
    it(`offers the way back to This computer, before and during the wait for the browser`, async () => {
        await mount();
        await pressing(`Back to This computer`);
        expect(openThisComputer).toHaveBeenCalledTimes(1);

        await pressing(`Continue with Google in your browser`);
        await pressing(`Back to This computer`);
        expect(openThisComputer).toHaveBeenCalledTimes(2);
    });

    // Its reader is already in the app: "Install the app" as the step still to come sent them nowhere.
    it(`does not offer installing the app as a step still to come`, async () => {
        const el = await mount();

        expect(el.textContent).not.toContain(`Install the app`);
        expect(el.textContent).not.toContain(`Paste one command`);
        expect(el.textContent).toContain(`Two steps to your first agent`);
    });
});

// The second way in, under Google's: one mailed code, typed here. The terms stand before anything is sent, a Google
// address is pointed at Google without being refused, and the guard's destination holds as it does for Google.
describe(`with email sign-in offered`, () => {
    beforeEach(() => {
        readSignInOptions.mockResolvedValue({ google: true, email: true });
        // Google's silent answer would sign the page in before the email road is touched.
        getIdToken.mockReturnValue(new Promise<never>(() => {}));
    });

    const field = (selector: string): HTMLInputElement | null => document.querySelector<HTMLInputElement>(selector);
    const button = (label: string): HTMLButtonElement | undefined =>
        [...document.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.includes(label));
    const type = async (input: HTMLInputElement | null, value: string): Promise<void> => {
        if (input === null) {
            throw new Error(`no field to type into`);
        }
        input.value = value;
        input.dispatchEvent(new Event(`input`));
        await nextTick();
    };
    const settle = async (): Promise<void> => {
        await new Promise((resolve) => setTimeout(resolve));
        await nextTick();
    };

    it(`offers the address beside Google, with the terms on screen and nothing pressable until there is one`, async () => {
        const el = await mount();

        expect(renderButton).toHaveBeenCalledTimes(1);
        expect(field(`input[type="email"]`)).toEqual(expect.any(HTMLInputElement));
        expect(el.textContent).toContain(`By continuing you agree to our`);
        expect(el.textContent).toContain(`Sign in with Google or email`);
        expect(button(`Continue with email`)?.disabled).toBe(true);
    });

    it(`mails the code, names where it went, and signs in on the sixth digit to the page that asked`, async () => {
        query.value = { returnTo: `/sandbox/usage` };
        const el = await mount();

        await type(field(`input[type="email"]`), `Ana@Corp.example`);
        button(`Continue with email`)?.click();
        await settle();

        expect(sendEmailCode).toHaveBeenCalledWith(`ana@corp.example`);
        expect(el.textContent).toContain(`We sent a 6-digit code to ana@corp.example.`);
        expect(el.textContent).toContain(`Send it again in 60s`);

        await type(field(`input[autocomplete="one-time-code"]`), `123 456`);
        await settle();

        expect(signInWithEmailCode).toHaveBeenCalledWith(`ana@corp.example`, `123456`);
        expect(push).toHaveBeenCalledWith(`/sandbox/usage`);
    });

    it(`points a Google address at Google without refusing it`, async () => {
        const el = await mount();

        await type(field(`input[type="email"]`), [`ana`, `gmail.com`].join(`@`));

        expect(el.textContent).toContain(`Continue with Google is faster`);
        expect(button(`Continue with email`)?.disabled).toBe(false);
    });

    it(`asks for a minute's rest when the platform says too many codes were asked for`, async () => {
        const { EmailCodeError } = await import(`../../client/auth/emailCode`);
        sendEmailCode.mockRejectedValue(new EmailCodeError(`rate-limited`, `Too many codes asked for at once. Wait a minute, then try again.`));
        const el = await mount();

        await type(field(`input[type="email"]`), `ana@corp.example`);
        button(`Continue with email`)?.click();
        await settle();

        expect(el.textContent).toContain(`Wait a minute, then try again.`);
        expect(field(`input[autocomplete="one-time-code"]`)).toBeNull();
    });

    it(`stays away entirely on a platform that does not mail codes`, async () => {
        readSignInOptions.mockResolvedValue(GOOGLE_ONLY);
        const el = await mount();

        expect(field(`input[type="email"]`)).toBeNull();
        expect(el.textContent).toContain(`Sign in with Google`);
        expect(el.textContent).not.toContain(`Sign in with Google or email`);
    });

    // The mail's link opens the system browser, not the app's window: the code is typed here, with no hand-off.
    it(`runs in place inside the installed app, and says to type the code`, async () => {
        desktopVersion.mockReturnValue(`1.316.0`);
        renderButton.mockResolvedValue(false);
        const el = await mount();

        await type(field(`input[type="email"]`), `ana@corp.example`);
        button(`Continue with email`)?.click();
        await settle();

        expect(signInThroughBrowser).not.toHaveBeenCalled();
        expect(el.textContent).toContain(`The link in the email opens your browser, not this app.`);
    });
});
