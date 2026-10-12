import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { packageRoot } from "@intentic/constants/node";

// ONE MODULE OWNS THE DAEMON'S MEMBER ROSTER (client/sandbox/useMembers.ts). The Access tab once kept its own copy in
// component refs while the agents board and the credential gates read the cache entry, so a grant moved one and not the
// others. Nothing else reads the entry's key, reads the roster by its route, or writes it: a screen asks `useMembers`, and
// a write goes through `grantMember` / `revokeMember`, which put the daemon's answer in the entry.

const appRoot = join(packageRoot(import.meta.url), `src`);
const OWNERS = new Set([`client/sandbox/useMembers.ts`, `lib/queryKeys.ts`]);
const RULES: readonly { readonly what: string; readonly pattern: RegExp }[] = [
    { what: `the roster's cache key`, pattern: /\bSANDBOX_MEMBERS\b/ },
    { what: `a roster read or write by its route`, pattern: /sandboxRaw\(\s*[`'"](?:GET|POST|DELETE) \/members[`'"]/ },
];

const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            return entry.name === `node_modules` || entry.name === `dist` ? [] : sourceFiles(full);
        }
        return (entry.name.endsWith(`.ts`) || entry.name.endsWith(`.vue`)) && !entry.name.endsWith(`.test.ts`) ? [full] : [];
    });

const sources = sourceFiles(appRoot).map((file) => ({ path: relative(appRoot, file).replaceAll(`\\`, `/`), text: readFileSync(file, `utf8`) }));

describe(`the member roster`, () => {
    it(`scans the app: a moved directory would otherwise read as a pass`, () => {
        expect(sources.length).toBeGreaterThan(200);
        expect(sources.filter(({ path }) => OWNERS.has(path)).map(({ path }) => path).toSorted()).toEqual([`client/sandbox/useMembers.ts`, `lib/queryKeys.ts`]);
    });

    for (const { what, pattern } of RULES) {
        it(`is not reached for ${what} outside its module`, () => {
            expect(sources.filter(({ path, text }) => !OWNERS.has(path) && pattern.test(text)).map(({ path }) => path)).toEqual([]);
        });
    }
});
