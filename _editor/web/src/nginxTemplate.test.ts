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

    // nginx's first matching regex wins, as here; a URI none matches gets the map's default.
    const cacheControlOf = (uri: string): string | undefined => {
        const block = /map \$request_uri \$cache_control \{([^}]*)\}/.exec(nginxConf)?.[1] ?? ``;
        const rules = [...block.matchAll(/^\s*(\S+)\s+"([^"]*)";/gm)].map((match) => ({ key: match[1] ?? ``, value: match[2] ?? `` }));
        const hit = rules.find((rule) => rule.key.startsWith(`~`) && new RegExp(rule.key.slice(1)).test(uri));
        return (hit ?? rules.find((rule) => rule.key === `default`))?.value;
    };

    it(`serves the service worker revalidated, and the shell and runtime config never cached`, () => {
        // The worker's update check must see each deploy's precache list (public/sw.js); index.html and env.js change per
        // deploy and are kept by the worker itself for outages, never by the HTTP cache.
        expect([cacheControlOf(`/sw.js`), cacheControlOf(`/`), cacheControlOf(`/assets/js/env.js`), cacheControlOf(`/assets/index-a1.js`)]).toEqual([
            `no-cache`,
            `no-store`,
            `no-store`,
            `public, max-age=31536000, immutable`,
        ]);
    });
});
