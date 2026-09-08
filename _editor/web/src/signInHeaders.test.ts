import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Pins that nginx.conf's response headers don't break Google sign-in: Referrer-Policy must still send Origin to
// accounts.google.com's cross-origin request, and CSP must still allow its script and frame.

const here = import.meta.dirname;
const nginxConf = readFileSync(resolve(here, `../nginx.conf`), `utf8`);

// Header lines only: nginx.conf's own comments already document these values, including `no-referrer`.
const directives = nginxConf
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`add_header `));

const valueOf = (header: string): string => {
    const line = directives.find((directive) => directive.toLowerCase().startsWith(`add_header ${header.toLowerCase()} `));
    expect(line, `nginx.conf sets no ${header}`).toEqual(expect.any(String));
    return /"([^"]*)"/.exec(line ?? ``)?.[1] ?? ``;
};

describe(`deployed web headers`, () => {
    // `same-origin` sounds like a lesser restriction, but it blocks every cross-origin request, Google's included.
    const withholdsOrigin = [`no-referrer`, `same-origin`];

    it(`sends the origin cross-origin, or Google refuses the sign-in client`, () => {
        const policy = valueOf(`Referrer-Policy`).toLowerCase();
        expect(withholdsOrigin, `Referrer-Policy "${policy}" hides this app's origin from Google's button endpoint`).not.toContain(policy);
    });

    it(`still lets Google's script and frame load at all`, () => {
        const csp = valueOf(`Content-Security-Policy`);
        const directive = (name: string): string => new RegExp(`${name} ([^;]*)`).exec(csp)?.[1] ?? ``;
        expect(directive(`script-src`)).toContain(`https://accounts.google.com`);
        expect(directive(`frame-src`)).toContain(`https://accounts.google.com`);
    });
});
