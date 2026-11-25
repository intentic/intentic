/* COMPAT TAGS: a branch kept only for an older far end says which, and from what release it is dead.

   `// compat(daemon<1.260.0): why` on a fallback branch reads "this serves a daemon older than 1.260.0, the first
   release that has what the other branch needs". Once the daemon floor (peer-floors.mjs) is 1.260.0 or later, every
   daemon the editor still serves has it, so the branch is dead and compat-tags.mjs fails until it goes. The same in a
   block comment, a Vue template comment or a `#` comment. How a line is read is here, apart from the walk, so the
   check's test can pin it. */
import { compareReleases, isRelease } from "./peer-floors.mjs";

// `compat(` … `):` on one line. A call such as Rust's `io.compat()` has no colon after its paren, so it is not a tag.
const TAG = /\bcompat\(([^()\n]*)\)(:?)([^\n]*)/gu;
const BODY = /^([a-z][a-z0-9-]*)<(\S+)$/u;

// What is wrong with each tag on `text`'s lines, against `floors` (peer id to its floor). Each finding is
// `{ line, tag, problem }`; a well-formed live tag is none.
export const tagFindings = (text, floors) => {
    const findings = [];
    for (const [index, line] of text.split("\n").entries()) {
        for (const [, body, colon, rest] of line.matchAll(TAG)) {
            if (colon !== ":") {
                continue;
            }
            const at = { line: index + 1, tag: `compat(${body})` };
            const parts = BODY.exec(body.trim());
            if (parts === null || !isRelease(parts[2])) {
                findings.push({ ...at, problem: `not a tag: write compat(<peer><<x.y.z>): <why>, the release that first has what the other branch needs` });
                continue;
            }
            const [, peer, version] = parts;
            const floor = floors.get(peer);
            if (floor === undefined) {
                findings.push({ ...at, problem: `names no peer with a floor (${[...floors.keys()].join(", ")}): a far end joins once it has one` });
            } else if (compareReleases(version, floor) <= 0) {
                findings.push({ ...at, problem: `dead: the ${peer} floor is ${floor}, so every ${peer} served has ${version}; delete this branch and keep the other` });
            } else if (rest.replace(/(?:\*\/|--!?>)\s*$/u, "").trim() === "") {
                findings.push({ ...at, problem: `says no why: name what the older ${peer} lacks after the colon` });
            }
        }
    }
    return findings;
};
