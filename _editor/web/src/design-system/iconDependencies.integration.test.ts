import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it(`keeps third-party icon packages out of the whole resolved dependency graph`, () => {
    const lock = readFileSync(new URL(`../../../../pnpm-lock.yaml`, import.meta.url), `utf8`);
    const packages = lock.split(`\npackages:\n`)[1]!.split(`\nsnapshots:\n`)[0]!;
    const names = [...packages.matchAll(/^ {2}([^\s].*):$/gmu)].map((match) => match[1]!);
    expect(names.length).toBeGreaterThan(0);
    expect(
        names.filter((name) => /(?:@iconify[/-]|@primevue\/icons|primeicons|lucide|heroicons|@fortawesome\/|remixicon|simple-icons)/u.test(name)),
    ).toEqual([]);
});
