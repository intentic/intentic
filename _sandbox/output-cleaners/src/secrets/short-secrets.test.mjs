import { expect, test } from "bun:test";
import { maskShortSecrets, shortSecretTargets } from "./short-secrets.mjs";

const ref = (name) => `{{secret:${name}}}`;
const mask = (text, targets) => maskShortSecrets(text, targets, ref);
const pw = [{ name: "Z440_ROOT_PASSWORD", value: "hunter2" }];

test("keeps only non-empty one-line values under the floor, trimmed", () => {
    expect(
        shortSecretTargets(
            [
                { name: "A", value: " abc " },
                { name: "B", value: "" },
                { name: "C", value: "a-long-enough-value" },
                { name: "D", value: "ab\ncd" },
            ],
            12,
        ),
    ).toEqual([{ name: "A", value: "abc" }]);
});

test.each([
    ["password=hunter2", "password={{secret:Z440_ROOT_PASSWORD}}"],
    ["PASSWORD: hunter2", "PASSWORD: {{secret:Z440_ROOT_PASSWORD}}"],
    ['{"password": "hunter2"}', '{"password": "{{secret:Z440_ROOT_PASSWORD}}"}'],
    ["{'db_pass':'hunter2'}", "{'db_pass':'{{secret:Z440_ROOT_PASSWORD}}'}"],
    ['{\\"password\\":\\"hunter2\\"}', '{\\"password\\":\\"{{secret:Z440_ROOT_PASSWORD}}\\"}'],
    ["export Z440_ROOT_PASSWORD=hunter2", "export Z440_ROOT_PASSWORD={{secret:Z440_ROOT_PASSWORD}}"],
    ["api_key = 'hunter2'", "api_key = '{{secret:Z440_ROOT_PASSWORD}}'"],
    ["token => hunter2,", "token => {{secret:Z440_ROOT_PASSWORD}},"],
    ["client_secret: hunter2", "client_secret: {{secret:Z440_ROOT_PASSWORD}}"],
    ["login --password hunter2 --user root", "login --password {{secret:Z440_ROOT_PASSWORD}} --user root"],
    ["login --db-pass=hunter2", "login --db-pass={{secret:Z440_ROOT_PASSWORD}}"],
    ["mysql -uroot -phunter2 db", "mysql -uroot -p{{secret:Z440_ROOT_PASSWORD}} db"],
    ["sshpass -p hunter2 ssh root@z440", "sshpass -p {{secret:Z440_ROOT_PASSWORD}} ssh root@z440"],
    ["git clone https://root:hunter2@git.example.com/r.git", "git clone https://root:{{secret:Z440_ROOT_PASSWORD}}@git.example.com/r.git"],
    ["a\npassword=hunter2\nb", "a\npassword={{secret:Z440_ROOT_PASSWORD}}\nb"],
])("masks a short value in a secret-like context: %s", (text, expected) => {
    expect(mask(text, pw)).toBe(expected);
});

test("a vault entry's field names it as a key", () => {
    expect(mask("password: s3cret", [{ name: "netdisk/password", value: "s3cret" }])).toBe("password: {{secret:netdisk/password}}");
    expect(mask("pin = 4821", [{ name: "bank/pin", value: "4821" }])).toBe("pin = {{secret:bank/pin}}");
    // `pin` is no secret word on its own: another secret's pin is left alone.
    expect(mask("pin = 4821", [{ name: "bank/code", value: "4821" }])).toBe("pin = 4821");
});

test.each([
    ["bare occurrence", "the hunter2 config"],
    ["a key that names no secret", "user=hunter2"],
    ["a longer value that starts with it", "password=hunter22"],
    ["a longer value that ends with it", "password=xhunter2"],
    ["a different case", "password=HUNTER2"],
    ["a key glued to a longer word after", "passwordless hunter2"],
    ["-p for a tool not known to take a password", "grep -phunter2 file"],
    ["a URL's user, not its password", "https://hunter2:other@host"],
    ["a URL path", "https://host/hunter2@x"],
])("leaves a short value alone outside a secret-like context: %s", (_label, text) => {
    expect(mask(text, pw)).toBe(text);
});

test("returns the same string when nothing matched, and handles regex characters in values and names", () => {
    const text = "no secrets here";
    expect(mask(text, pw)).toBe(text);
    expect(mask("password=a.b*c", [{ name: "x.y", value: "a.b*c" }])).toBe("password={{secret:x.y}}");
    expect(mask("password=aXbYc", [{ name: "x.y", value: "a.b*c" }])).toBe("password=aXbYc");
});

test("masks every occurrence and several secrets in one text", () => {
    const targets = [...pw, { name: "netdisk/password", value: "nd42" }];
    expect(mask("password=hunter2 password=nd42 again password=hunter2", targets)).toBe(
        "password={{secret:Z440_ROOT_PASSWORD}} password={{secret:netdisk/password}} again password={{secret:Z440_ROOT_PASSWORD}}",
    );
});
