import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/* THE RESPONSE HEADERS SIGN-IN DEPENDS ON, pinned where they are cheap to check.
 *
 * Google Identity Services decides whether this app may sign anyone in by reading the ORIGIN off the Referer
 * the browser attaches to its cross-origin request for accounts.google.com/gsi/button. That header is the
 * only place the origin travels, so a Referrer-Policy that withholds it refuses a perfectly well-configured
 * OAuth client, and refuses it in the worst available shape: Google logs "The given origin is not allowed
 * for the given client ID", which reads as a console setting somebody broke, and the button renders 0×0,
 * takes clicks, and does nothing. That happened, from `no-referrer` in nginx.conf, and the whole pipeline
 * stayed green through it.
 *
 * The deploy smoke check (smoke-signin.mjs) is the real proof, because only a real browser against the real
 * origin can get a straight answer out of Google. But it can only run AFTER the image is built, pushed and
 * deployed, so it reports this class of mistake as a failed production deploy. This test costs milliseconds
 * and reports it as a failed edit, which is where the mistake actually is.
 *
 * Scoped to what sign-in needs and nothing else: the rest of that header set is security policy this has no
 * standing to freeze, and a test that pinned all of it would be a second copy of the file. */

const here = dirname(fileURLToPath(import.meta.url));
const nginxConf = readFileSync(resolve(here, `../nginx.conf`), `utf8`);

// The header lines only: the file explains itself at length, and those comments quote the very values this
// asserts on (including the `no-referrer` this exists to forbid).
const directives = nginxConf
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`add_header `));

const valueOf = (header: string): string => {
    const line = directives.find((directive) => directive.toLowerCase().startsWith(`add_header ${header.toLowerCase()} `));
    expect(line, `nginx.conf sets no ${header}`).toBeDefined();
    return /"([^"]*)"/.exec(line ?? ``)?.[1] ?? ``;
};

describe(`deployed web headers`, () => {
    /* The policies that send NOTHING cross-origin. `same-origin` is in here too and is the subtle one: it
     * sounds like a tightening of the value below rather than what it is, a total blackout on every request
     * that leaves this app, Google's included. */
    const withholdsOrigin = [`no-referrer`, `same-origin`];

    it(`sends the origin cross-origin, or Google refuses the sign-in client`, () => {
        const policy = valueOf(`Referrer-Policy`).toLowerCase();
        expect(withholdsOrigin, `Referrer-Policy "${policy}" hides this app's origin from Google's button endpoint`).not.toContain(policy);
    });

    it(`still lets Google's script and frame load at all`, () => {
        const csp = valueOf(`Content-Security-Policy`);
        const directive = (name: string): string => new RegExp(`${name} ([^;]*)`).exec(csp)?.[1] ?? ``;
        // The script mints the credential; the frame IS the button. Losing either is the same dead front door
        // by a different route, and neither failure names itself any more clearly than the referrer one did.
        expect(directive(`script-src`)).toContain(`https://accounts.google.com`);
        expect(directive(`frame-src`)).toContain(`https://accounts.google.com`);
    });
});
