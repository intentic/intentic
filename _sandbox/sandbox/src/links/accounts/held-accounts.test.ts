import { CapabilitySchema } from "@intentic/sandbox-contract/schemas/capabilities";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { heldFrom, linkAccountsOf, namedHeld, type HeldReadings } from "./held-accounts.js";

// HOW EACH ACCOUNT MAY REACH ANOTHER SANDBOX: copied when its key does not rotate, lent when its renewal must stay here,
// and refused with a reason a person reads otherwise. The doors read the same list, so what the page says is what they do.

const row = (id: string, extra: Partial<OauthAccount> = {}): OauthAccount => ({ id, label: id, connectedAt: 1, ...extra });

const EMPTY_TRANSLATOR = { codex: [], grok: [], kimi: [], gemini: [] };

const readings = (over: Partial<HeldReadings> = {}): HeldReadings => ({
    claude: [],
    usage: {},
    cursor: [],
    devin: [],
    minted: {},
    translator: undefined,
    capabilities: [],
    ...over,
});

const modes = (input: HeldReadings): string[] =>
    heldFrom(input).map(({ ref, mode }) => `${ref.provider}${ref.account === undefined ? "" : `:${ref.account}`}=${mode}`);

describe("held accounts", () => {
    it("lends a working Claude sign-in, and refuses a revoked one or one that is itself borrowed", () => {
        const claude = [row("c-1"), row("c-2", { needsReauth: true }), row("lent-9", { borrowedFrom: { name: "ops" } })];
        expect(modes(readings({ claude }))).toEqual(["claude:c-1=lend", "claude:c-2=no", "claude:lent-9=no"]);
        const reasons = heldFrom(readings({ claude })).map((held) => held.reason);
        expect(reasons[1]).toMatch(/signing in again here/);
        expect(reasons[2]).toMatch(/borrowed from ops/);
    });

    it("copies static keys and endpoints, and names the translator's subscriptions without lending them", () => {
        const endpoint = CapabilitySchema.parse({ id: "openrouter", kind: "endpoint", config: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" } });
        const input = readings({
            cursor: [row("cur-1")],
            devin: [row("dev-1")],
            minted: { zai: [row("z-1")] },
            translator: { ...EMPTY_TRANSLATOR, codex: [{ name: "codex-me.json", label: "me@example.com" }] },
            capabilities: [endpoint],
        });
        expect(modes(input)).toEqual(["codex=no", "cursor:cur-1=copy", "devin:dev-1=copy", "zai:z-1=copy", "endpoint/openrouter=copy"]);
    });

    it("answers at the door only for what the terms name and may still go", () => {
        const held = heldFrom(readings({ claude: [row("c-1"), row("c-2", { needsReauth: true })], cursor: [row("cur-1")] }));
        const terms = [
            { provider: "claude", account: "c-1" },
            { provider: "claude", account: "c-2" },
        ];
        expect(namedHeld(held, terms, { provider: "claude", account: "c-1" })?.mode).toBe("lend");
        // Named, but revoked since: refused, as an unnamed one is.
        expect(namedHeld(held, terms, { provider: "claude", account: "c-2" })).toBeUndefined();
        expect(namedHeld(held, terms, { provider: "cursor", account: "cur-1" })).toBeUndefined();
        expect(linkAccountsOf(held, terms).map((account) => account.id)).toEqual(["c-1"]);
    });
});
