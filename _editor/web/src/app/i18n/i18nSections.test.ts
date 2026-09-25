import { readFileSync } from "node:fs";
import { join } from "node:path";
import base from "./locales/en.json";

// Every top-level section of the editor's catalog is typed (index.ts declares it on vue-i18n's message schema), so a
// section added to en.json and forgotten there is refused here rather than read as `any` by every key under it.
// Read as text: the declaration is a type, and a type leaves nothing behind at runtime to ask.

const declared = [...readFileSync(join(import.meta.dirname, `index.ts`), `utf8`).matchAll(/^\s+readonly "?([\w-]+)"?: AppMessages\[/gm)].map(
    (match) => match[1],
);

it(`types every top-level section of en.json, and only those`, () => {
    expect(declared.toSorted()).toEqual(Object.keys(base).toSorted());
});
