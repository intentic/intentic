import { type TranscriptRow, TranscriptRowSchema } from "@intentic/sandbox-contract/events/transcript";
import { pesel } from "@intentic/privacy-detect/testing";
import { privacySliceFake } from "../privacy-slice.testing.js";
import { shieldedInReplies } from "../shielded-replies.js";

// The words a reply's model never read: values it wrote as tokens and the shield put back, which the chat marks so the
// model does not seem to know what it was never told (reported 2026-11-06, a test document read back with every name).

const PESEL = pesel(1984, 3, 14);
const row = (role: TranscriptRow["role"], text: string): TranscriptRow => TranscriptRowSchema.parse({ role, text });

const shieldWith = async (mode: "on" | "off", trusted: string[] = []) => {
    const { privacyShield } = privacySliceFake({ policy: { mode, trusted } });
    // The request that went out: the value given its token, as the gateway gives it.
    await (await privacyShield.masker(await privacyShield.policy())).mask(`Klient Jan Kowalski, PESEL ${PESEL}`);
    return privacyShield;
};

const deps = (shield: Awaited<ReturnType<typeof shieldWith>>, rows: readonly TranscriptRow[]) => ({
    shield,
    provider: (id: string) => (id === "c-1" ? "claude" : undefined),
    rows: async () => rows,
});

describe("the words a reply's model never read", () => {
    test("a value the vault holds in a reply is named with the token its model wrote; a person's own words are not", async () => {
        const shield = await shieldWith("on");
        const rows = [row("user", `Kim jest Jan Kowalski?`), row("assistant", `Jan Kowalski ma PESEL ${PESEL}, a Jan Kowalski podpisał umowę.`)];
        const found = await shieldedInReplies(deps(shield, rows), "c-1");
        expect(found).toEqual(
            expect.arrayContaining([
                { text: PESEL, token: "⟦NATIONAL_ID_1⟧", class: "national-id" },
                expect.objectContaining({ text: "Jan Kowalski", class: "person-name" }),
            ]),
        );
        expect(found).toHaveLength(2);
    });

    test("only read: nothing the vault does not already hold is found, and no token is given", async () => {
        const shield = await shieldWith("on");
        const before = await shield.vault.counts();
        const found = await shieldedInReplies(deps(shield, [row("assistant", `Anna Nowak, PESEL ${pesel(1990, 1, 1)}`)]), "c-1");
        expect(found).toEqual([]);
        expect(await shield.vault.counts()).toEqual(before);
    });

    test("nothing while the provider reads values as they are: shield off, provider trusted, or a conversation nobody knows", async () => {
        const rows = [row("assistant", `Jan Kowalski`)];
        expect(await shieldedInReplies(deps(await shieldWith("off"), rows), "c-1")).toEqual([]);
        expect(await shieldedInReplies(deps(await shieldWith("on", ["claude"]), rows), "c-1")).toEqual([]);
        expect(await shieldedInReplies(deps(await shieldWith("on"), rows), "c-2")).toEqual([]);
    });
});
