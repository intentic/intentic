import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";

const REPO_ROOT = repoRoot(import.meta.url);

/* A SETUP CODE IS A VALUE, AND ARGV CANNOT TELL A VALUE FROM A FLAG. */

// The platform mints the code, so it may begin with any character at all — and everything downstream reads a
// leading hyphen as a flag. Base64url's `-` put one code in 64 in front of clap as `error: unexpected argument '-T'
// found`, and the only test that could see it drew one code per nightly run.
//
// The scripts pass a code behind `--`; the machine's argument builder and the minter have behavioral tests of their own.
const CODE_CARRIERS: readonly (readonly [string, RegExp])[] = [
    ["_site/site/public/scripts/connect.sh", /sandbox connect "\$@" -- "\$SETUP_CODE"/],
    ["_site/site/public/scripts/connect.ps1", /\$IcArgs \+= '--'/],
];

test("the connect scripts pass a setup code behind the end-of-flags marker", async () => {
    for (const [carrier, marked] of CODE_CARRIERS) {
        const content = await readFile(join(REPO_ROOT, carrier), "utf8");
        expect(
            marked.test(content),
            `${carrier}: must pass the setup code to ic behind \`--\`. A code is a minted value and may begin ` +
                `with a hyphen; without the marker the parser reads it as a flag and the install dies after Docker is ready.`,
        ).toBe(true);
    }
});
