import { expect, test } from "vitest";
import { generatePassword } from "./accounts-tools.js";

/* The generator is the one pure piece of the accounts tools (the rest is SDK-tool wiring over the stores, the
 * hashline precedent), and it mints REAL credentials — so what is worth holding is the policy: long enough,
 * every class present (sites that demand "one uppercase, one digit, one symbol" must never bounce a generated
 * password into a retry loop the agent cannot see the reason for), and drawn from the conservative symbol set
 * virtually every policy accepts. */
test("a generated password satisfies the strictest common site policy", () => {
    for (let round = 0; round < 50; round += 1) {
        const password = generatePassword();
        expect(password).toHaveLength(20);
        expect(password).toMatch(/[a-z]/);
        expect(password).toMatch(/[A-Z]/);
        expect(password).toMatch(/[0-9]/);
        expect(password).toMatch(/[!@#$%^*\-_+=]/);
        // Nothing outside the declared sets — an exotic character is a character some site rejects.
        expect(password).toMatch(/^[a-zA-Z0-9!@#$%^*\-_+=]+$/);
    }
});

test("two generated passwords are never the same credential", () => {
    const minted = new Set(Array.from({ length: 200 }, () => generatePassword()));
    expect(minted.size).toBe(200);
});
