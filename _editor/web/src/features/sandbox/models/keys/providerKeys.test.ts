import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import { keyRows } from "./providerKeys";

/* A vendor's API key as a row of the provider card it is filed under: which key, who bills it, whether it serves. */

const held = (id: string, overrides: Partial<CapabilitySummary> = {}): CapabilitySummary => ({
    id,
    kind: `endpoint`,
    status: { state: `active` },
    config: { baseUrl: `https://api.anthropic.com`, protocol: `anthropic`, hasSecret: true, keyHint: `a3f9` },
    secrets: [`apiKey`],
    ...overrides,
});

const ANTHROPIC = { id: `endpoint/anthropic`, label: `anthropic` };

test("a serving key reads as its last four characters and who bills it, never the key", () => {
    expect(keyRows(`claude`, [ANTHROPIC], [held(`anthropic`)])).toEqual([
        {
            provider: `endpoint/anthropic`,
            capability: `anthropic`,
            title: `API key ··a3f9`,
            note: `Billed per token by Anthropic`,
            state: `connected`,
            settling: false,
            description: undefined,
        },
    ]);
});

test("a key that does not serve says why in the daemon's words, and asks the reader, not an admin", () => {
    const [row] = keyRows(`claude`, [ANTHROPIC], [held(`anthropic`, { status: { state: `pending`, detail: `no models yet` } })]);
    expect(row).toMatchObject({ state: `reauth`, settling: false, description: `no models yet` });
    // Something under way that moves on its own is a wait, not a fault.
    const [settling] = keyRows(`claude`, [ANTHROPIC], [held(`anthropic`, { status: { state: `pending`, detail: `applying`, settling: true } })]);
    expect(settling).toMatchObject({ state: `unknown`, settling: true });
});

// A reader below Full access cannot read the capability list: the key is still named, without a hint it was never sent.
test("with no capability list to read, a key is plainly an API key, serving as the daemon lists it", () => {
    expect(keyRows(`claude`, [ANTHROPIC], [])).toEqual([expect.objectContaining({ title: `API key`, state: `connected`, description: undefined })]);
});

test("two keys with no hint to tell them apart are told apart by their own names", () => {
    const second = { id: `endpoint/anthropic-2`, label: `anthropic-2` };
    expect(keyRows(`claude`, [ANTHROPIC, second], []).map((row) => row.note)).toEqual([
        `Billed per token by Anthropic · anthropic`,
        `Billed per token by Anthropic · anthropic-2`,
    ]);
});
