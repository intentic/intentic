import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";

const REPO_ROOT = repoRoot(import.meta.url);

/* A SETUP CODE IS A VALUE, AND ARGV CANNOT TELL A VALUE FROM A FLAG. */

// The platform mints the code, so it may begin with any character at all — and everything downstream reads a
// leading hyphen as a flag. Both halves of the rule are pinned below, because either one alone is a bug
// waiting on a draw: base64url's `-` put one code in 64 in front of clap as `error: unexpected argument '-T'
// found`, and the only test that could see it drew one code per nightly run.
//
// A new caller that hands ic a code belongs in this table, passing it behind `--` like the three here.
const CODE_CARRIERS: readonly (readonly [string, RegExp])[] = [
    ["_site/site/public/scripts/connect.sh", /sandbox connect "\$@" -- "\$SETUP_CODE"/],
    ["_site/site/public/scripts/connect.ps1", /\$IcArgs \+= '--'/],
    // A reconnect's `--replace` sits between `-y` and the marker; what matters is that the marker comes before the code.
    ["_devices/machine/src/device/tools/sandboxes.ts", /"connect", "-y",[^\n]*"--", setupCode/],
];
// The minting half: base62, so no code ever starts with the hyphen the carriers above defend against.
const CODE_MINTER = "_platform/api/src/sandbox/mint-sandbox.ts";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// The encoding CALL, not the word: the minter's own comment names base64url to explain what it cost, and a
// file explaining a footgun must not read as committing it.
const BASE64URL_CALL = /toString\(\s*[`'"]base64url/;

test("a setup code reaches ic as a value: minted without a hyphen, and passed behind the end-of-flags marker", async () => {
    for (const [carrier, marked] of CODE_CARRIERS) {
        const content = await readFile(join(REPO_ROOT, carrier), "utf8");
        expect(
            marked.test(content),
            `${carrier}: must pass the setup code to ic behind \`--\`. A code is a minted value and may begin ` +
                `with a hyphen; without the marker the parser reads it as a flag and the install dies after Docker is ready.`,
        ).toBe(true);
    }
    const minter = await readFile(join(REPO_ROOT, CODE_MINTER), "utf8");
    expect(
        minter.includes(BASE62),
        `${CODE_MINTER}: must mint from the base62 alphabet — its own comment says what the two extra characters cost.`,
    ).toBe(true);
    expect(BASE64URL_CALL.test(minter), `${CODE_MINTER}: minting base64url again, so one secret in 64 starts with a hyphen.`).toBe(false);
});
