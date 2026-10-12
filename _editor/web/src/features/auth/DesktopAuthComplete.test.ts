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
jest.mock(`vue-router`, () => ({
    ...actualVueRouter,
    // SAFETY: the page reads nothing of the router but `replace`, and nothing of the route but its query.
    useRouter: () => ({ push: jest.fn(), replace }) as never,
    // SAFETY: as above, the query alone.
    useRoute: () => ({ query: { handoff: `row-1`, verifier: `v`.repeat(43) } }) as never,
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

beforeEach(() => {
    replace.mockReset();
    refresh.mockClear();
    adoptIdToken.mockReset().mockReturnValue(true);
    redeem.mockReset();
    verify.mockClear();
    stubGlobal(`fetch`, verify);
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

it(`stops at a Google proof too old to keep, rather than opening a workspace no daemon will take`, async () => {
    redeem.mockResolvedValue({ ott: `ott-1`, idToken: `stale-token` });
    adoptIdToken.mockReturnValue(false);

    const el = await mount();

    expect(el.textContent).toContain(`That sign-in had already expired.`);
    expect(replace).not.toHaveBeenCalled();
});
