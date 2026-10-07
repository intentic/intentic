import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Pins that nginx.conf lets the editor's own page use the microphone: "Talk hands-free" records in-page, and the
// `microphone=()` this header carried until 2026-10 had every Chromium refuse getUserMedia before any prompt, so the
// button failed on every press with nothing the person could allow.

const here = import.meta.dirname;
const nginxConf = readFileSync(resolve(here, `../nginx.conf`), `utf8`);

// The header line only: nginx.conf's comment beside it quotes the old `microphone=()`.
const policy = /^\s*add_header Permissions-Policy "([^"]*)"/m.exec(nginxConf)?.[1];

const allowlists = new Map(
    (policy ?? ``)
        .split(/,\s*/)
        .filter(Boolean)
        .map((directive): [string, string] => {
            const [feature = ``, allowlist = ``] = directive.split(`=`);
            return [feature.trim(), allowlist.trim()];
        }),
);

describe(`the deployed Permissions-Policy`, () => {
    it(`lets the page itself record, and names no other origin`, () => {
        expect(policy, `nginx.conf sets no Permissions-Policy`).toEqual(expect.any(String));
        expect(allowlists.get(`microphone`)).toBe(`(self)`);
    });

    it(`still denies what the app does not use`, () => {
        expect(allowlists.get(`camera`)).toBe(`()`);
        expect(allowlists.get(`geolocation`)).toBe(`()`);
    });
});
