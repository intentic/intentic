import "@intentic/testing/dom";
import { desktopSyncLink } from "../../app/environments/desktop";
import { sandboxSummary } from "../../testing/sandboxSummary";
import type { SyncPairing } from "../sandbox/devices/sync/useDesktopSync";
import { type ProjectHandoffHost, useProjectHandoff } from "./hostedProject";
import { setupProjectOf } from "./setupArrival";

// Pins the hand-over of a hosted project's folder to the desktop app: a fresh pairing on the sandbox's own address, in a
// sync link naming the project and the sandbox, only inside the app and only for a machine of ours; and a hand-over
// that fails keeps the page with the reason on it, until one goes through.

const HOSTED = sandboxSummary({ id: `s1`, name: `My App`, daemonUrl: `https://sandbox-abc.sbx.test`, hosted: { region: `iad`, warm: false } });
const FAILED = `Couldn't hand your folder to the app yet. Trying again…`;

const stage = (over: Partial<ProjectHandoffHost> = {}) => {
    const mint = jest.fn(over.mint ?? (async (): Promise<SyncPairing> => ({ token: `fresh+pair&`, mode: `sync` })));
    const sandboxOf = jest.fn(over.sandboxOf ?? ((_id: string) => HOSTED));
    const open = jest.fn((_link: string) => undefined);
    const handoff = useProjectHandoff({ project: setupProjectOf(`My App`), inApp: () => true, open, ...over, mint, sandboxOf });
    return { mint, sandboxOf, open, ...handoff };
};

it(`hands the app a fresh pairing on the sandbox's own address, naming the project and the sandbox it went to`, async () => {
    const { mint, open, sandboxOf, handOff, refusal } = stage();
    expect(await handOff(`s1`)).toBe(true);
    expect({ asked: sandboxOf.mock.calls, minted: mint.mock.calls.length, refusal: refusal.value }).toEqual({ asked: [[`s1`]], minted: 1, refusal: undefined });
    expect(open.mock.calls).toEqual([[`intentic://sync?url=https%3A%2F%2Fsandbox-abc.sbx.test&pair=fresh%2Bpair%26&name=My+App&project=My-App&sandbox=s1`]]);
});

it.each<[string, Partial<ProjectHandoffHost>]>([
    [`outside the app`, { inApp: () => false }],
    [`for a sandbox on this computer`, { sandboxOf: () => sandboxSummary({ id: `s1`, daemonUrl: `https://sandbox-abc.sbx.test` }) }],
    [`for a row the registry no longer lists`, { sandboxOf: () => undefined }],
    [`for a setup that is not a project's`, { project: undefined }],
])(`hands nothing over %s, and lets the workspace open`, async (_, over) => {
    const { mint, open, handOff } = stage(over);
    expect(await handOff(`s1`)).toBe(true);
    expect({ minted: mint.mock.calls.length, opened: open.mock.calls.length }).toEqual({ minted: 0, opened: 0 });
});

it.each<[string, Partial<ProjectHandoffHost>, { readonly minted: number; readonly detail: string | undefined }]>([
    [`the daemon refuses a pairing`, { mint: async () => { throw new Error(`Couldn't start desktop sync (503).`); } }, { minted: 1, detail: `Couldn't start desktop sync (503).` }],
    [`the pairing syncs no folder`, { mint: async (): Promise<SyncPairing> => ({ token: `t`, mode: `mirror` }) }, { minted: 1, detail: undefined }],
    [`the sandbox has no address to pair with`, { sandboxOf: () => ({ ...HOSTED, daemonUrl: null }) }, { minted: 0, detail: undefined }],
])(`keeps the page, saying so, when %s`, async (_, over, expected) => {
    const { mint, open, handOff, refusal } = stage(over);
    expect(await handOff(`s1`)).toBe(false);
    expect({ minted: mint.mock.calls.length, opened: open.mock.calls.length, refusal: refusal.value }).toEqual({
        minted: expected.minted,
        opened: 0,
        refusal: { tone: `warning`, title: FAILED, detail: expected.detail },
    });
});

it(`takes back what it said once a later hand-over goes through`, async () => {
    const { mint, open, handOff, refusal } = stage();
    mint.mockRejectedValueOnce(new Error(`offline`));
    expect(await handOff(`s1`)).toBe(false);
    expect(refusal.value).toEqual({ tone: `warning`, title: FAILED, detail: `offline` });
    expect(await handOff(`s1`)).toBe(true);
    expect({ refusal: refusal.value, opened: open.mock.calls.length }).toEqual({ refusal: undefined, opened: 1 });
});

// The link a project's hand-over rides (desktop.ts): the project and the sandbox are the app's to bind to the folder it
// parked and to remember, each only when named; an ordinary sync link is unchanged.
describe(`the sync link`, () => {
    it(`names a project and its sandbox, encoded, beside the address and pairing`, () => {
        const link = desktopSyncLink({ url: `https://s.test`, pair: `p`, name: `My App`, project: `My-App`, sandbox: `id&2`, takeover: true });
        expect(link).toBe(`intentic://sync?url=https%3A%2F%2Fs.test&pair=p&name=My+App&project=My-App&sandbox=id%262&takeover=1`);
    });

    it(`leaves out a blank project or sandbox, and names neither on an ordinary link`, () => {
        expect(desktopSyncLink({ url: `https://s.test`, pair: `p`, project: ``, sandbox: `` })).toBe(`intentic://sync?url=https%3A%2F%2Fs.test&pair=p`);
        expect(desktopSyncLink({ url: `https://s.test`, pair: `p`, name: `My App` })).toBe(`intentic://sync?url=https%3A%2F%2Fs.test&pair=p&name=My+App`);
    });
});
