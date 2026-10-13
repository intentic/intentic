// The app's webview redeeming the row the browser parked: the one-time token becomes this webview's session, and the
// Google proof beside it, when there is one, joins the shared cache. An account that signs in by email code carries
// none, and its daemon sessions come from the platform's identity assertions instead.
import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import * as actualVueRouter from "vue-router";

// Mounting reads matchMedia (ui) and window.env (environment.ts) at module scope; see Setup.test.ts.

const replace = jest.fn();

/** What the app points this page at (auth.rs `complete_path`); `back` rides a sign-in begun in a folder's window. */
interface CompleteQuery {
    handoff: string;
    verifier: string;
    back?: string;
}

// Written per test, by property: the mock reads it at every `useRoute`.
const query: CompleteQuery = { handoff: `row-1`, verifier: `v`.repeat(43) };
jest.mock(`vue-router`, () => ({
    ...actualVueRouter,
    // SAFETY: the page reads nothing of the router but `replace`, and nothing of the route but its query.
    useRouter: () => ({ push: jest.fn(), replace }) as never,
    // SAFETY: as above, the query alone.
    useRoute: () => ({ query }) as never,
}));
const refresh = jest.fn(async () => ({ email: `ana@corp.example` }));
jest.mock(`../../client/auth/useAuth`, () => ({ useAuth: () => ({ user: ref(null), refresh }) }));
const adoptIdToken = jest.fn<(credential: string) => boolean>();
jest.mock(`../../client/auth/useGoogleIdentity`, () => ({ useGoogleIdentity: () => ({ adoptIdToken }) }));
const redeem = jest.fn<(input: { handoff: string; verifier: string }) => Promise<{ ott: string; idToken?: string }>>();
jest.mock(`../../lib/useApi`, () => ({ apiClient: { desktop: { redeem: (input: { handoff: string; verifier: string }) => redeem(input) } } }));

const { default: DesktopAuthComplete } = await import("./DesktopAuthComplete.vue");

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(DesktopAuthComplete) });
    app.component(`Icon`, IconStub);
    app.mount(el);
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
    return el;
};

// The one-time token's verify, whose Set-Cookie is the whole of what it gives.
const verify = jest.fn(async () => new Response(`{}`, { status: 200 }));

// The links this page hands the app, caught where they leave (desktop.ts sends them over `location.href`).
const heard: string[] = [];

beforeEach(() => {
    replace.mockReset();
    refresh.mockClear();
    adoptIdToken.mockReset().mockReturnValue(true);
    redeem.mockReset();
    verify.mockClear();
    delete query.back;
    heard.length = 0;
    stubGlobal(`fetch`, verify);
    Object.defineProperty(document, `readyState`, { configurable: true, get: () => `complete` });
    stubGlobal(`location`, {
        get href(): string {
            return heard.at(-1) ?? ``;
        },
        set href(link: string) {
            heard.push(link);
        },
    });
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    unstubAllGlobals();
});

it(`adopts the Google proof the row carried, then opens the workspace`, async () => {
    redeem.mockResolvedValue({ ott: `ott-1`, idToken: `google-id-token` });

    await mount();

    expect(adoptIdToken).toHaveBeenCalledWith(`google-id-token`);
    expect(replace).toHaveBeenCalledWith(`/`);
});

it(`opens the workspace on the session alone for an account with no Google token`, async () => {
    redeem.mockResolvedValue({ ott: `ott-1` });

    const el = await mount();

    expect(verify).toHaveBeenCalledTimes(1);
    expect(adoptIdToken).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(`/`);
    expect(el.textContent).not.toContain(`expired`);
});

// The report this came from: "Work on this with an agent" on a folder asked for a sign-in, and the reader came back to
// the account's sandbox list with nothing on screen about that folder. The workspace still has to mount — it is what
// tells the app who signed in and which sandboxes the account has — and then the reader goes back where they asked.
it(`hands the reader back to this computer when the sign-in began in a folder's window`, async () => {
    redeem.mockResolvedValue({ ott: `ott-1` });
    query.back = `agent`;

    await mount();

    expect(replace).toHaveBeenCalledWith(`/`);
    expect(heard).toEqual([`intentic://launcher?to=agent`]);
});

it(`stays in the workspace for a sign-in that began there`, async () => {
    redeem.mockResolvedValue({ ott: `ott-1` });

    await mount();

    expect(replace).toHaveBeenCalledWith(`/`);
    expect(heard).toEqual([]);
});

it(`stops at a Google proof too old to keep, rather than opening a workspace no daemon will take`, async () => {
    redeem.mockResolvedValue({ ott: `ott-1`, idToken: `stale-token` });
    adoptIdToken.mockReturnValue(false);

    const el = await mount();

    expect(el.textContent).toContain(`That sign-in had already expired.`);
    expect(replace).not.toHaveBeenCalled();
});
