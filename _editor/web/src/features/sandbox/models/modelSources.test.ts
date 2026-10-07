import type { AccountState } from "@intentic/sandbox-contract";
import { type AccountReading, modelSources, sourcesNeedingSomeone } from "./modelSources";

// The overview at the top of Sandbox ▸ Models: one row per thing this sandbox can run a model on, and what needs a
// person first. It replaced eight chips that each showed one provider, so "is any of it broken" took eight presses.

const when = (epochSeconds: number): string => `at ${epochSeconds}`;
const ready: AccountState = { kind: `ready`, room: 80 };
const account = (label: string, state: AccountState = ready): AccountReading => ({ label, state });

it(`lists only providers that hold something, and names a lone account by who it signs in as`, () => {
    const sources = modelSources(
        [
            { kind: `account`, provider: `claude`, label: `Claude`, accounts: [account(`you@example.com`)] },
            { kind: `account`, provider: `cursor`, label: `Cursor`, accounts: [] },
            { kind: `account`, provider: `codex`, label: `ChatGPT`, accounts: [account(`a@example.com`), account(`b@example.com`)] },
        ],
        when,
    );

    // In the grid's order, so a source and the tile it sits under agree.
    expect(sources.map((source) => source.provider)).toEqual([`claude`, `codex`]);
    expect(sources.find((source) => source.provider === `claude`)?.summary).toBe(`you@example.com`);
    expect(sources.find((source) => source.provider === `codex`)?.summary).toBe(`2 accounts`);
    expect(sources.every((source) => source.standing === `ready` && source.line === undefined)).toBe(true);
});

it(`puts what a person can fix first, saying which account and what to do`, () => {
    const sources = modelSources(
        [
            { kind: `account`, provider: `codex`, label: `ChatGPT`, accounts: [account(`fine@example.com`)] },
            {
                kind: `account`,
                provider: `claude`,
                label: `Claude`,
                accounts: [account(`work`), account(`home`, { kind: `blocked`, fix: `reconnect`, reason: `Signed out` })],
            },
        ],
        when,
    );

    expect(sources[0]).toMatchObject({ provider: `claude`, standing: `attention`, line: `home: sign in again` });
    expect(sourcesNeedingSomeone(sources)).toBe(1);
});

it(`counts several accounts needing a person rather than naming one of them`, () => {
    const [claude] = modelSources(
        [
            {
                kind: `account`,
                provider: `claude`,
                label: `Claude`,
                accounts: [
                    account(`one`, { kind: `blocked`, fix: `reconnect`, reason: `Signed out` }),
                    account(`two`, { kind: `blocked`, fix: `verify`, reason: `Confirm it`, url: `https://example.com` }),
                ],
            },
        ],
        when,
    );

    expect(claude).toMatchObject({ standing: `attention`, line: `2 accounts need you` });
});

// A seat only an organisation's admin can hand back is not the reader's to fix, and is told apart by its tone; with
// another account serving, the provider still runs and nothing is owed.
it(`tells a seat only an admin can restore from one the reader can fix`, () => {
    const lost = account(`team`, { kind: `blocked`, fix: `admin`, reason: `Seat removed` });
    const [alone] = modelSources([{ kind: `account`, provider: `claude`, label: `Claude`, accounts: [lost] }], when);
    expect(alone).toMatchObject({ standing: `blocked`, line: `team: an organisation admin has to restore the seat` });

    const [covered] = modelSources([{ kind: `account`, provider: `claude`, label: `Claude`, accounts: [lost, account(`mine`)] }], when);
    expect(covered?.standing).toBe(`ready`);
});

it(`says when a provider whose every account is resting serves again, and sorts it after the ones that serve`, () => {
    const sources = modelSources(
        [
            {
                kind: `account`,
                provider: `claude`,
                label: `Claude`,
                accounts: [
                    account(`one`, { kind: `spent`, reopensAt: 2000 }),
                    account(`two`, { kind: `blocked`, fix: `wait`, reason: `Busy`, until: 1500 }),
                ],
            },
            { kind: `local`, provider: `endpoint:qwen`, label: `Qwen3 30B` },
        ],
        when,
    );

    expect(sources.map((source) => source.provider)).toEqual([`endpoint:qwen`, `claude`]);
    expect(sources[1]).toMatchObject({ standing: `waiting`, line: `Resting until at 1500` });
    expect(sourcesNeedingSomeone(sources)).toBe(0);
});

it(`mentions accounts resting beside ones that serve, since turns may land on another account meanwhile`, () => {
    const [claude] = modelSources(
        [{ kind: `account`, provider: `claude`, label: `Claude`, accounts: [account(`one`), account(`two`, { kind: `spent` })] }],
        when,
    );

    expect(claude).toMatchObject({ standing: `ready`, line: `1 of 2 resting for now` });
});

it(`points a model on this machine and an endpoint at the cards that manage them, and counts the trial down`, () => {
    const sources = modelSources(
        [
            { kind: `trial`, provider: `trial`, label: `Free trial`, remaining: 0 },
            { kind: `endpoint`, provider: `endpoint:openrouter`, label: `OpenRouter` },
            { kind: `local`, provider: `endpoint:qwen`, label: `Qwen3 30B` },
        ],
        when,
    );

    expect(sources.map((source) => [source.label, source.summary, source.manage])).toEqual([
        [`Qwen3 30B`, `Runs on this machine`, `/capabilities/localmodel`],
        [`OpenRouter`, `Your own server`, `/capabilities/endpoint`],
        [`Free trial`, `0 free messages left today`, undefined],
    ]);
    expect(sources[2]).toMatchObject({ standing: `waiting`, line: `Today's free messages are used up` });
});
