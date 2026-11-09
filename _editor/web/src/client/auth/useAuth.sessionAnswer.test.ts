import { ref } from "vue";

// What counts as the platform's answer to a session check (2026-11-09): a session or `null`. A 200 carrying anything
// else (a captive portal's page, a proxy's text) is no answer, so it must neither sign the window out nor read as
// "signed out" to the guards; it is an unanswered check, which the outage handling takes from there.

const getSession = jest.fn<() => Promise<{ data: unknown; error: null }>>();
const clearSessions = jest.fn();
jest.mock(`better-auth/client`, () => ({ createAuthClient: () => ({ getSession }) }));
jest.mock(`../session/sandboxSession`, () => ({ useSandboxSession: () => ({ clearSessions, retireAccountAccess: jest.fn() }) }));
jest.mock(`./useGoogleIdentity`, () => ({ useGoogleIdentity: () => ({ clearCredential: jest.fn() }) }));
jest.mock(`../../lib/queryPersistence`, () => ({ clearPersistedQueries: jest.fn(async () => undefined) }));
jest.mock(`../../app/environments/local`, () => ({ localFace: () => undefined }));
jest.mock(`../../app/environments/desktop`, () => ({ announceDesktopRoster: jest.fn() }));
jest.mock(`../directory/deviceDirectory`, () => ({ forgetAccount: jest.fn() }));
jest.mock(`../directory/directState`, () => ({ directMode: ref(false) }));
jest.mock(`@intentic/ui/skeleton-store`, () => ({ clearImprints: jest.fn(async () => undefined) }));

const { useAuth } = await import(`./useAuth`);
const { platformHealth } = await import(`../../lib/platform/platformHealth`);

beforeEach(() => {
    getSession.mockReset();
    clearSessions.mockReset();
});

it(`reads the platform's null as signed out`, async () => {
    getSession.mockResolvedValue({ data: null, error: null });
    await expect(useAuth().refresh()).resolves.toBe(null);
});

it.each([
    [`a captive portal's page`, `<!doctype html><title>Sign in to the hotel Wi-Fi</title>`],
    [`an object that is not a session`, { ok: true }],
])(`takes %s for no answer, signs nothing out, and reads the platform as down`, async (_case, data) => {
    getSession.mockResolvedValue({ data, error: null });
    await expect(useAuth().refresh()).rejects.toThrow();
    expect(clearSessions).not.toHaveBeenCalled();
    expect(platformHealth.down.value).toBe(true);
});
