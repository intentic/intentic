import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { type HarnessFacts, harnessesFrom, standingOf } from "./computerHarnesses";

const account = (extra: Partial<OauthAccount> = {}): OauthAccount => ({ id: `this-computer`, label: `Claude Team`, connectedAt: 1, ...extra });
const facts = (extra: Partial<HarnessFacts> = {}): HarnessFacts => ({
    loops: { claude: [`native`], codex: [`native`], opencode: [`native`] },
    native: [`claude`],
    agents: [{ id: `opencode`, label: `OpenCode` }],
    accounts: {},
    read: new Set(),
    refused: new Set(),
    ...extra,
});

// What stands between a coding agent of this computer and a turn, judged from what the sidecar lists, what the harness
// states of its own sign-in, and what its last turn found.
describe(`a harness's standing on this computer`, () => {
    it(`needs setting up when the listing names it and cannot run it yet`, () => {
        expect(standingOf(`codex`, facts())).toBe(`setUp`);
    });

    it(`is not called signed out before its account list has been read`, () => {
        expect(standingOf(`claude`, facts())).toBe(`ready`);
        expect(standingOf(`claude`, facts({ read: new Set([`claude`]) }))).toBe(`signIn`);
    });

    it(`runs once the harness states a sign-in`, () => {
        expect(standingOf(`claude`, facts({ read: new Set([`claude`]), accounts: { claude: [account()] } }))).toBe(`ready`);
    });

    // A harness lists its stored sign-in whether or not it still works: only the turn it refuses finds out.
    it(`needs signing in after a refused turn, though an account is listed`, () => {
        const listed = { read: new Set([`claude`]), accounts: { claude: [account()] } };
        expect(standingOf(`claude`, facts({ ...listed, refused: new Set([`claude`]) }))).toBe(`signIn`);
        expect(standingOf(`claude`, facts({ read: listed.read, accounts: { claude: [account({ needsReauth: true })] } }))).toBe(`signIn`);
    });
});

describe(`the harnesses of this computer`, () => {
    it(`lists every one the sidecar names, the runnable first, under the program's own name`, () => {
        const listed = harnessesFrom(facts({ read: new Set([`claude`]), accounts: { claude: [account()] } }));
        expect(listed.map((harness) => [harness.id, harness.label, harness.standing])).toEqual([
            [`claude`, `Claude Code`, `ready`],
            [`opencode`, `OpenCode`, `ready`],
            [`codex`, `Codex`, `setUp`],
        ]);
        expect(listed[0]?.account?.label).toBe(`Claude Team`);
    });

    // The account and model routes take a provider the contract names; a program it does not keeps both to itself.
    it(`says which of them the account and model routes answer for`, () => {
        expect(harnessesFrom(facts()).map((harness) => [harness.id, harness.asked])).toEqual([
            [`claude`, true],
            [`opencode`, false],
            [`codex`, true],
        ]);
    });

    it(`is empty for a computer with none, and for a listing from before the field`, () => {
        expect(harnessesFrom(facts({ loops: undefined, native: [], agents: [] }))).toEqual([]);
    });
});
