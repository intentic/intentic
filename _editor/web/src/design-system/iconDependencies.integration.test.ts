import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { repoRoot } from "@intentic/constants/node";

it(`keeps third-party icon packages out of the whole resolved dependency graph`, () => {
    const lock = readFileSync(join(repoRoot(import.meta.url), `pnpm-lock.yaml`), `utf8`);
    const packages = lock.split(`\npackages:\n`)[1]!.split(`\nsnapshots:\n`)[0]!;
    const names = [...packages.matchAll(/^ {2}([^\s].*):$/gmu)].map((match) => match[1]!);
    expect(names.length).toBeGreaterThan(0);
    expect(
        names.filter((name) => /(?:@iconify[/-]|@primevue\/icons|primeicons|lucide|heroicons|@fortawesome\/|remixicon|simple-icons)/u.test(name)),
    ).toEqual([]);
});
