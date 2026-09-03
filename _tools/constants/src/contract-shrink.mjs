/* WHAT A WIRE-CONTRACT LOCK LOST, as one comparison shared by everything that asks it.
 *
 * contract.lock.json is the sandbox-contract package's exported schemas as one comparable document
 * (_sandbox/sandbox-contract/src/contract-lock.ts explains the pair). Three readers ask what a newer lock no
 * longer offers: the checkout gate that refuses an undeclared shrink at the push (_tools/checks/contract-shrink.mjs),
 * the landing drafter that forces the `!` and the Breaking-Note into the commit message
 * (_sandbox/sandbox/src/git/contract-shrink.ts), and the tests that hold both to the same judgment. One
 * implementation here, hand-written JavaScript rather than compiled TypeScript for the same reason node.mjs
 * beside it is: the gate runs before `pnpm install`, so it imports this file by relative path and nothing else.
 *
 * ADDITIONS NEVER APPEAR IN THE RESULT. Every reader of the wire parses loosely, so growth breaks nobody, and a
 * detector that flagged growth would put a false `!` on ordinary work.
 *
 * ARRAYS ARE THE SCHEMA'S COLLECTIONS (`oneOf` alternatives, `enum` values, `required` names) and the lock
 * writer keeps them in declaration order rather than sorting, so a position means nothing on its own: every
 * base element must be matched by SOME head element, and extras pass in silence exactly like a new property
 * does. An element that merely changed reads as removed: the same verdict either way.
 *
 * `description` AS A KEYWORD IS PROSE, AND PROSE IS NOT A PROMISE. zod's `.describe()` rides into the lock
 * beside the shape, so re-wording a help sentence used to read as "a surface changed" and demand a `!` commit.
 * Nothing on the wire moves when it does. It is skipped ONLY as a keyword: 78 schemas in this lock carry a
 * real field NAMED `description`, and losing one of those is a genuine break, so the walk tracks whether the
 * object it is reading is a name map (keys are fields) or a schema (keys are keywords). */

// The JSON Schema keywords whose value is a map of NAME to schema: inside one a key is a field the wire
// carries, everywhere else a key is a keyword. The lock's own root is one too (its keys are the exported
// schema names), which is why the walk starts `named`.
const NAME_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions"]);

const dotted = (at, key) => (at === "" ? key : `${at}.${key}`);

// Every surface `base` offers that `head` no longer does, as dotted paths.
export const shrunkSurfaces = (base, head, at = "", out = [], named = true) => {
    if (Array.isArray(base) || Array.isArray(head)) {
        if (!Array.isArray(base) || !Array.isArray(head)) {
            out.push(at);
            return out;
        }
        for (const [index, item] of base.entries()) {
            const itemAt = typeof item === "object" && item !== null ? `${at}[${index}]` : `${at} ${JSON.stringify(item)}`;
            const offered = head.some((candidate) => shrunkSurfaces(item, candidate, itemAt, [], false).length === 0);
            if (!offered) {
                out.push(itemAt);
            }
        }
        return out;
    }
    if (typeof base !== "object" || base === null || typeof head !== "object" || head === null) {
        if (JSON.stringify(base) !== JSON.stringify(head)) {
            out.push(at);
        }
        return out;
    }
    for (const key of Object.keys(base)) {
        if (!named && key === "description") {
            continue;
        }
        if (key in head) {
            shrunkSurfaces(base[key], head[key], dotted(at, key), out, !named && NAME_MAPS.has(key));
        } else {
            out.push(dotted(at, key));
        }
    }
    return out;
};

// The same comparison over the two texts of a lock file. Either side failing to parse yields NO shrink rather
// than a throw: one reader feeds a commit-message draft, and a mangled lock is the contract-lock test's failure
// to report, not a reason to draft nothing.
export const lockShrinkage = (baseText, headText) => {
    try {
        return shrunkSurfaces(JSON.parse(baseText), JSON.parse(headText));
    } catch {
        return [];
    }
};
