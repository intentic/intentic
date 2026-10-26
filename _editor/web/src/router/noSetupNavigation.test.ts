import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// NOTHING NAVIGATES TO /setup (2026-10-26). A new sandbox is made, and one left unfinished finished, on Home, in a dialog
// and a tile of its own (features/home/newSandbox/), and the reader is never moved out of the view they are in to do it.
// The setup page that used to be its own place is gone; its old addresses only land on Home (router/setupRoutes.ts). A
// link, a push or a redirect written to it anywhere else would take a reader off Home again, through a redirect that
// happens to save them: this keeps anyone from writing one.

const SRC = resolve(import.meta.dirname, `..`);

// The two places that may name it: the redirects that land its old addresses on Home, and the shell gate, whose answer
// for an account with nothing to open the shell settles to Home (app/environments/nothingToOpen.ts).
const ALLOWED = new Set([`router/setupRoutes.ts`, `router/setupGate.ts`]);

// A navigation to it, in any of the shapes this code base writes one: a template link, a push or a replace, a location
// object, an address assigned.
const NAVIGATION = [/to="\/setup\b/, /href="\/setup\b/, /\b(?:push|replace|assign)\(\s*[`'"]\/setup\b/, /\bpath:\s*[`'"]\/setup\b/];

const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return sources(path);
        }
        return /\.(?:ts|vue)$/.test(entry.name) && !entry.name.endsWith(`.test.ts`) ? [path] : [];
    });

const navigates = (line: string): boolean => NAVIGATION.some((pattern) => pattern.test(line));

// Each line of `path` that navigates to it, said as `file:line: text`.
const navigationsIn = (path: string): string[] => {
    const file = relative(SRC, path);
    if (ALLOWED.has(file)) {
        return [];
    }
    return readFileSync(path, `utf8`)
        .split(`\n`)
        .flatMap((line, at) => (navigates(line) ? [`${file}:${at + 1}: ${line.trim()}`] : []));
};

describe(`navigations to the setup page`, () => {
    it(`are written nowhere but the redirects that land its old addresses on Home`, () => {
        expect(sources(SRC).flatMap(navigationsIn)).toEqual([]);
    });
});
