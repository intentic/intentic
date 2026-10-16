import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { requires } from "@intentic/testing/requires";
import { lex } from "./secret-command-lex.js";

const bash = requires(existsSync("/bin/bash"), "bash at /bin/bash");

// Compare shell words with real bash, keeping fd 3 for the oracle so stdout/stderr redirects cannot hide its argv.
// No command under test reaches the network, writes a file, or expands an ambient variable.
const words = [
    "one\\\ntwo",
    "--\\\nlocation",
    "a\\\n b",
    "\\\n one",
    '""',
    "''",
    "one''two",
    "'one two'",
    '"one\\\ntwo"',
    '"one\\qtwo"',
    '"one\\@two"',
    '"\\$VALUE"',
    '"\\`literal\\`"',
    '"\\\\"',
    "'one\\\ntwo'",
    "\\2",
    "2\\\n3",
    "'123'>/dev/null",
    "\\123>/dev/null",
    "2\\\n>/dev/null",
    '2>"/dev/null"',
    "2>&1",
    "one # discarded words",
    "https://api.\\\ngithub.com",
    "R\\\n=value",
    "R='value'",
    "'R'=value",
    ...["left", "--", "R=", "https://api.", "2"].flatMap((left) => ["right", "location", "value"].map((right) => `${left}\\\n${right}`)),
];

describe.skipIf(!bash.runs)(bash.title("shell word agreement with bash"), () => {
    it.each(words)("preserves argv for %s", (source) => {
        const output = execFileSync(
            "/bin/bash",
            ["--noprofile", "--norc", "-c", `exec 3>&1\ncapture() { if [ "$#" -gt 0 ]; then printf '%s\\0' "$@" >&3; fi; }\ncapture ${source}`],
            { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
        );
        const expected = output === "" ? [] : output.slice(0, -1).split("\0");
        expect(lex(`capture ${source}`)).toEqual({
            segments: [
                [
                    { text: "capture", dynamic: false, assignment: false },
                    ...expected.map((text) => ({
                        text,
                        dynamic: false,
                        assignment: /^[A-Za-z_][A-Za-z0-9_]*=/.test(source.replaceAll("\\\n", "")),
                    })),
                ],
            ],
        });
    });
});
