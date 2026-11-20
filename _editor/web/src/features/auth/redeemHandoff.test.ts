// How a hand-off reached the app is counted with whether it signed the webview in, so a link the browser never launched
// shows (`via: platform`) instead of a reader left on "waiting" with nothing on either side to say why.
import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";

const track = jest.fn();
jest.mock(`../../app/analytics`, () => ({ track }));
const refresh = jest.fn(async () => ({ email: `ana@corp.example` }));
jest.mock(`../../client/auth/useAuth`, () => ({ useAuth: () => ({ refresh }) }));
jest.mock(`../../client/auth/useGoogleIdentity`, () => ({ useGoogleIdentity: () => ({ adoptIdToken: () => true }) }));
const redeem = jest.fn<() => Promise<{ ott: string; idToken?: string }>>();
jest.mock(`../../lib/useApi`, () => ({ apiClient: { desktop: { redeem: () => redeem() } } }));

const { readDesktopHandoff, redeemDesktopHandoff } = await import("./redeemHandoff");

beforeEach(() => {
    track.mockClear();
    redeem.mockReset();
    stubGlobal(`fetch`, jest.fn(async () => new Response(`{}`, { status: 200 })));
});
afterEach(() => unstubAllGlobals());

test(`reads how the hand-off came: the link unless the app says it found it on the platform`, () => {
    expect(readDesktopHandoff({ handoff: `h`, verifier: `v` })?.via).toBe(`link`);
    expect(readDesktopHandoff({ handoff: `h`, verifier: `v`, via: `platform` })?.via).toBe(`platform`);
    expect(readDesktopHandoff({ handoff: `h`, verifier: `v`, via: `elsewhere` })?.via).toBe(`link`);
});

test(`counts a hand-off the app found on the platform, signed in`, async () => {
    redeem.mockResolvedValue({ ott: `ott-1` });
    const taken = readDesktopHandoff({ handoff: `h`, verifier: `v`, via: `platform` });

    await expect(redeemDesktopHandoff(taken)).resolves.toBeUndefined();

    expect(track).toHaveBeenCalledWith(`desktop_signin_arrived`, { via: `platform`, ok: true });
});

test(`counts a refused one as not signed in`, async () => {
    redeem.mockRejectedValue(new Error(`spent`));

    expect(await redeemDesktopHandoff(readDesktopHandoff({ handoff: `h`, verifier: `v` }))).toEqual(expect.any(Object));

    expect(track).toHaveBeenCalledWith(`desktop_signin_arrived`, { via: `link`, ok: false });
});
