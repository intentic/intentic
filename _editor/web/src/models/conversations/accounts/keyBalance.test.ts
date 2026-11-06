import { formatAmount } from "@intentic/ui/format";
import { balanceLabel, balanceLow, balanceTip } from "./keyBalance";
import { endpointProviders } from "../../providers/providerCatalog";

// Nothing here reads the daemon; stubbed only so importing the query wrapper doesn't pull in the daemon client.
jest.mock("../../../client/sandbox/sandboxRpc", () => ({ sandboxRpc: {} }));

const AT = Date.parse(`2026-11-06T12:00:00Z`);

describe(`an API key's balance`, () => {
    afterEach(() => {
        endpointProviders.value = [];
    });

    // Dollars the way every price here is said; any other currency in its own sign.
    it(`says what is left, and of how much where the key has a cap`, () => {
        expect(balanceLabel({ remaining: 49.588, currency: `USD`, measuredAt: AT })).toBe(`$49.59 left`);
        expect(balanceLabel({ remaining: 7.25, currency: `USD`, limit: 20, measuredAt: AT })).toBe(`$7.25 of $20.00 left`);
        expect(formatAmount(110, `CNY`)).toContain(`110`);
        expect(formatAmount(110, `CNY`)).not.toContain(`$`);
    });

    // A cap warns by share, an account's credit by what one more turn may cost.
    it(`turns to a warning near where the vendor refuses the next request`, () => {
        expect(balanceLow({ remaining: 1.5, currency: `USD`, limit: 20, measuredAt: AT })).toBe(true);
        expect(balanceLow({ remaining: 10, currency: `USD`, limit: 20, measuredAt: AT })).toBe(false);
        expect(balanceLow({ remaining: 0.8, currency: `USD`, measuredAt: AT })).toBe(true);
        expect(balanceLow({ remaining: 25, currency: `USD`, measuredAt: AT })).toBe(false);
    });

    it(`names the key's vendor on its card, with the cap and its reset only where there is one`, () => {
        endpointProviders.value = [{ id: `endpoint/moonshot`, label: `moonshot`, kind: `endpoint`, beside: `kimi` }];
        const tip = balanceTip(`endpoint/moonshot`, { remaining: 3, currency: `USD`, measuredAt: AT - 60_000 }, AT);
        expect(tip.title).toBe(`Credit on Moonshot API key`);
        expect(tip.rows.map((row) => row.label)).toEqual([`Left`, `Read`]);

        const capped = balanceTip(`endpoint/openrouter`, { remaining: 0.4, currency: `USD`, limit: 5, resetsAt: AT / 1000 + 3600, measuredAt: AT }, AT);
        expect(capped.rows.map((row) => row.label)).toEqual([`Left`, `Cap`, `Resets`, `Read`]);
        expect(capped.tone).toBe(`warning`);
    });
});
