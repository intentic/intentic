#!/usr/bin/env node
/* NO CONTROL CHARACTERS IN TRACKED TEXT: the byte-level invariant that keeps this repo readable.
 *
 * A NUL typed straight into a string literal is invisible in an editor and decisive everywhere else: git, grep,
 * `file`, code review and every diff viewer sniff for one and call the whole file binary. It is an easy thing to
 * write on purpose: a separator that cannot occur in the data is a real technique, and it cost this repo five
 * files, one of which spent six days and eighteen commits with no reviewable diff before anyone noticed.
 *
 * It then cost seven more, because this script was only ever reachable through `pnpm check` — no hook, no CI job,
 * nothing automatic. Being right is not the same as being run. It is now a step in the pre-push hook and in the
 * `preflight` job, both of which need only a checkout, which is the whole reason it reads bytes and not a build.
 *
 * The technique is fine; the spelling is not. The escape (backslash-u-0000) is the same code point at runtime
 * and leaves the file text, so this check asks for it and nothing else.
 *
 * Genuinely binary content is skipped by extension rather than by sniffing, because sniffing is exactly the
 * thing that goes wrong here: a source file that LOOKS binary is the bug, not the exemption. */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

// What is allowed to hold arbitrary bytes. Extensions, not paths: an image is an image wherever it lands.
const BINARY = new Set([
    `png`,
    `jpg`,
    `jpeg`,
    `gif`,
    `webp`,
    `avif`,
    `ico`,
    `icns`,
    `pdf`,
    `woff`,
    `woff2`,
    `ttf`,
    `otf`,
    `eot`,
    `zip`,
    `gz`,
    `tgz`,
    `br`,
    `wasm`,
    `mp4`,
    `webm`,
    `mp3`,
    `wav`,
    `bin`,
    `node`,
    `keystore`,
    `jks`,
]);

// C0 controls minus the three every text file legitimately contains. DEL rides along: it is as invisible as the
// rest and has no business in source either.
const forbidden = (byte) => (byte < 0x09 && byte !== 0x00) || byte === 0x0b || byte === 0x0c || (byte >= 0x0e && byte <= 0x1f) || byte === 0x7f;

const tracked = execFileSync(`git`, [`ls-files`, `-z`], { encoding: `buffer` }).toString(`utf8`).split(`\0`).filter(Boolean);

const findings = [];
for (const path of tracked) {
    if (BINARY.has(path.split(`.`).pop()?.toLowerCase() ?? ``)) {
        continue;
    }
    let bytes;
    try {
        if (!statSync(path).isFile()) {
            continue;
        }
        bytes = readFileSync(path);
    } catch {
        continue; // a submodule, a symlink to nowhere, a path removed since `ls-files` answered
    }
    for (let at = 0; at < bytes.length; at++) {
        const byte = bytes[at];
        if (byte === 0x00 || forbidden(byte)) {
            const line = bytes.subarray(0, at).toString(`utf8`).split(`\n`).length;
            findings.push({ path, line, byte });
            break; // one report per file is enough to send someone to it
        }
    }
}

if (findings.length > 0) {
    for (const { path, line, byte } of findings) {
        const name = byte === 0x00 ? `NUL` : `0x${byte.toString(16).padStart(2, `0`)}`;
        console.error(`${path}:${line}  literal ${name}: write it as an escape (\\u${byte.toString(16).padStart(4, `0`)}) so the file stays text`);
    }
    console.error(`\n${findings.length} file(s) carry a literal control character. Git, grep and every diff viewer read those as binary.`);
    process.exit(1);
}

console.log(`${tracked.length} tracked files, no literal control characters`);
