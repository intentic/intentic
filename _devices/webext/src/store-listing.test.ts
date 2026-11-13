import { readFileSync } from "node:fs";

// THE STORE REFUSES A PERMISSION NOBODY JUSTIFIED. The Chrome Web Store accepts the upload and then answers the publish
// with a 400, "does not meet the requirements", until the dashboard has a sentence for every permission the manifest
// asks for. Three releases went out that way before any of them published: v1.353.0 (`nativeMessaging`), v1.401.0
// (`userScripts`) and v1.413.0 (`downloads`), each found by a failed publish job and a fix agent reading its log. The
// sentences reviewers read live in STORE-LISTING.md, so a permission added without one fails here, on the commit that
// adds it, rather than at the release.

interface Manifest {
    readonly permissions?: readonly string[];
    readonly optional_permissions?: readonly string[];
    readonly optional_host_permissions?: readonly string[];
    readonly host_permissions?: readonly string[];
    readonly content_scripts?: readonly { readonly matches: readonly string[] }[];
}

// SAFETY: the extension's own manifest, which Chrome itself validates at load; only these keys are read, each as optional.
const manifest = JSON.parse(readFileSync(new URL("../static/manifest.json", import.meta.url), "utf8")) as Manifest;
const listing = readFileSync(new URL("../STORE-LISTING.md", import.meta.url), "utf8");

// The first cell of every row of the listing's "Permission | Justification" table, with the justification beside it.
const justified = new Map(
    listing
        .split("\n")
        .map((line) => /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/.exec(line))
        .flatMap((match) => (match === null || match[1] === undefined || match[2] === undefined ? [] : [[match[1], match[2]] as const]))
        .filter(([cell, why]) => cell.includes("`") && why.length > 20),
);
const rowFor = (needle: string): readonly [string, string] | undefined => [...justified].find(([cell]) => cell.includes(needle));

test.each(manifest.permissions ?? [])("`%s` has a justification for the store's reviewers", (permission) => {
    expect(rowFor(`\`${permission}\``)?.[0]).toContain(`\`${permission}\``);
});

// An optional one says so: reviewers weigh a permission asked for at a click differently from one held from install.
test.each(manifest.optional_permissions ?? [])("optional `%s` has a justification that says it is optional", (permission) => {
    expect(rowFor(`\`${permission}\``)?.[0]).toContain(`(optional)`);
});

test("host permissions have a justification naming each pattern", () => {
    for (const pattern of [...(manifest.host_permissions ?? []), ...(manifest.optional_host_permissions ?? [])]) {
        expect(rowFor(`\`${pattern}\``)?.[0]).toContain(`host permissions`);
    }
});

test("every content script's sites have a justification", () => {
    for (const pattern of (manifest.content_scripts ?? []).flatMap((script) => script.matches)) {
        expect(rowFor(`\`${pattern}\``)?.[0]).toContain(`Content script`);
    }
});
