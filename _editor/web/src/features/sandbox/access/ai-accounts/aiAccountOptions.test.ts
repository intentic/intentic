import { type AiAccountSources, aiAccountRows } from "./aiAccountOptions";
import { isFamily } from "../pick/multiPick";

// What the AI accounts picker offers: every account by the key the daemon judges a turn by, a provider's accounts as one
// family, a provider holding none of its own by its own id, and a local model never as a row.

const NOTES = { endpoint: `API endpoint`, agent: `Installed agent` } as const;
const rowsOf = (sources: Partial<AiAccountSources>) => aiAccountRows({ providers: [], endpoints: [], agents: [], ...sources }, (kind) => NOTES[kind]);

const claude = {
    id: `claude`,
    label: `Claude`,
    native: [
        { id: `home`, label: `Home`, email: `ana@home.example`, connectedAt: 0 },
        { id: `work`, label: `Work`, connectedAt: 1 },
    ],
    routed: [],
};

describe(`aiAccountRows`, () => {
    it(`keys each account as the daemon does, and groups a provider's accounts as one family`, () => {
        const { entries, providerOf } = rowsOf({ providers: [claude] });
        const family = entries.find(isFamily);
        expect(family?.label).toBe(`Claude`);
        expect(family?.options.map((option) => [option.value, option.label, option.detail])).toEqual([
            [`claude:home`, `Home`, `ana@home.example`],
            [`claude:work`, `Work`, undefined],
        ]);
        expect(providerOf.get(`claude:work`)).toBe(`claude`);
    });

    it(`draws a provider's single account as one row naming the provider, a routed one by its auth file`, () => {
        const codex = { id: `codex`, label: `Codex`, native: [], routed: [{ name: `codex-ana.json`, label: `ana` }] };
        expect(rowsOf({ providers: [codex] }).entries).toEqual([{ value: `codex:codex-ana.json`, label: `ana`, detail: undefined, note: `Codex` }]);
    });

    it(`names an endpoint or an installed agent by its own id, and leaves a local model out as always available`, () => {
        const rows = rowsOf({
            endpoints: [
                { id: `endpoint/gateway`, label: `Gateway`, kind: `endpoint` },
                { id: `endpoint/llama`, label: `Llama`, kind: `localmodel` },
            ],
            agents: [{ id: `goose`, label: `Goose` }],
        });
        expect(rows.entries).toEqual([
            { value: `endpoint/gateway`, label: `Gateway`, note: `API endpoint` },
            { value: `goose`, label: `Goose`, note: `Installed agent` },
        ]);
        expect(rows.alwaysAvailable).toEqual([`Llama`]);
    });

    it(`offers nothing for a provider with no account connected`, () => {
        expect(rowsOf({ providers: [{ id: `cursor`, label: `Cursor`, native: [], routed: [] }] }).entries).toEqual([]);
    });
});

describe(`who connected each account`, () => {
    const by = (email: string) => (email === `ana@home.example` ? `Connected by you` : `Connected by ${email}`);
    const shared = {
        ...claude,
        native: [
            { id: `home`, label: `Home`, email: `ana@home.example`, connectedAt: 0, connectedBy: `ana@home.example` },
            { id: `work`, label: `Work`, connectedAt: 1, connectedBy: `jo@acme.dev` },
            { id: `old`, label: `Old`, connectedAt: 2 },
        ],
    };

    it(`says it quietly after who the account signs in as, the reader as you, and nothing where nobody was recorded`, () => {
        const family = aiAccountRows({ providers: [shared], endpoints: [], agents: [] }, (kind) => NOTES[kind], by).entries.find(isFamily);
        expect(family?.options.map((option) => [option.value, option.detail])).toEqual([
            [`claude:home`, `ana@home.example · Connected by you`],
            [`claude:work`, `Connected by jo@acme.dev`],
            [`claude:old`, undefined],
        ]);
    });

    it(`says nothing of a connector when no words for one are handed in`, () => {
        const family = rowsOf({ providers: [shared] }).entries.find(isFamily);
        expect(family?.options.map((option) => option.detail)).toEqual([`ana@home.example`, undefined, undefined]);
    });
});
