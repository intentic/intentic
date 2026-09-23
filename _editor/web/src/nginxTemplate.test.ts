import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Pins the one coupling between nginx.conf and entrypoint.sh: the entrypoint renders the template with an
// envsubst RESTRICTED to a named list (an unrestricted one would blank every $uri), so a `${…}` the list does
// not name is served to browsers verbatim. The deploy gate reads one of these values back off the public
// origin, so a literal there is a production deploy that can only fail on its timeout.

const here = import.meta.dirname;
const nginxConf = readFileSync(resolve(here, `../nginx.conf`), `utf8`);
const entrypoint = readFileSync(resolve(here, `../entrypoint.sh`), `utf8`);

const substituted = new Set(
    (/envsubst\s+'([^']*)'[\s\\]*<\s*\/etc\/nginx\/default\.conf\.template/.exec(entrypoint)?.[1] ?? ``)
        .split(/\s+/)
        .filter(Boolean)
        .map((name) => name.replace(/^\$/, ``)),
);

describe(`the rendered nginx config`, () => {
    it(`names every placeholder nginx.conf carries in the template's envsubst`, () => {
        const used = [...nginxConf.matchAll(/\$\{(\w+)\}/g)].flatMap((match) => match[1] ?? []);
        expect(used.length, `no \${…} left in nginx.conf — this test is pinning nothing`).toBeGreaterThan(0);
        for (const name of new Set(used)) {
            expect(substituted, `nginx.conf uses \${${name}}, which entrypoint.sh's envsubst does not name`).toContain(name);
        }
    });

    it(`serves the image's build id, which the platform deploy waits on`, () => {
        const header = nginxConf.split(/\r?\n/).find((line) => line.trim().startsWith(`add_header X-Web-Build `));
        // deploy-platform.sh polls this header to tell the incoming container from the outgoing one.
        expect(header, `nginx.conf serves no X-Web-Build`).toEqual(expect.any(String));
        expect(header).toContain(`"\${WEB_BUILD}"`);
    });
});
