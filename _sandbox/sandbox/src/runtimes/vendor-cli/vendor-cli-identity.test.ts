import { emailIn } from "./vendor-cli-identity.js";

/* Who a sign-in belongs to, read off the token file the CLI wrote. */

const jwt = (claims: object): string => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

test("an email the file states outright is who signed in", () => {
    expect(emailIn({ user: { email: "dev@example.com" }, access_token: "opaque" })).toBe("dev@example.com");
});

test("an ID token's email claim is who signed in, wherever the file keeps it", () => {
    expect(emailIn({ "https://auth.x.ai::client": { key: "opaque", id_token: jwt({ sub: "1", email: "grok@example.com" }) } })).toBe(
        "grok@example.com",
    );
    expect(emailIn([jwt({ email: "kimi@example.com" })])).toBe("kimi@example.com");
});

test("a file naming nobody is a nameless sign-in", () => {
    expect(emailIn({ access_token: jwt({ sub: "1" }), refresh_token: "a.b.c" })).toBeUndefined();
    expect(emailIn({ email: "not an address" })).toBeUndefined();
});
