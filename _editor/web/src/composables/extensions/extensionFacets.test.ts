import { STATE_DIR } from "@intentic/constants";
import type { ExtensionManifest } from "@intentic/extension-manifest";
import { describe, expect, it } from "vitest";
import { facetsOf, searchTextOf } from "./extensionFacets";

const manifest = (contributes: ExtensionManifest["contributes"]): ExtensionManifest => ({
    publisher: `intentic`,
    name: `documentation`,
    version: `1.0.0`,
    engines: { intentic: `^1.0.0` },
    contributes,
});

const labels = (contributes: ExtensionManifest["contributes"]): string[] => facetsOf(manifest(contributes)).map((facet) => facet.label);

describe(`facetsOf`, () => {
    it(`names the place a view shows up, per surface, counted`, () => {
        expect(
            labels({
                views: [
                    { id: `docs`, label: `Documentation`, surface: `rail` },
                    { id: `repo`, label: `Docs`, surface: `directory` },
                    { id: `other`, label: `More docs`, surface: `directory` },
                ],
            }),
        ).toEqual([`rail tile`, `2 workspace panels`]);
    });

    it(`carries the real names, not counts, for the expanded breakdown`, () => {
        const [facet] = facetsOf(manifest({ commands: [{ command: `documentation.generate`, title: `Generate documentation` }] }));
        expect(facet).toEqual({ kind: `commands`, label: `command`, names: [`Generate documentation`], surface: true });
    });

    it(`keeps wiring out of the one-line strip but not out of the record`, () => {
        const [facet] = facetsOf(manifest({ files: [{ path: `${STATE_DIR}/docs/`, invalidates: [`documentation`] }] }));
        expect(facet).toMatchObject({ label: `watched files`, names: [`.intentic/docs/`], surface: false });
    });

    it(`skips a declared-but-empty array rather than saying "0 commands"`, () => {
        expect(labels({ commands: [], views: [{ id: `docs`, label: `Documentation`, surface: `sandbox` }] })).toEqual([`sandbox tab`]);
    });

    /* The property the old counts line was written for and this one has to keep: a contribution point added to
     * the schema must show up WITHOUT an edit here. The enumerated version that preceded it silently omitted six
     * kinds, so this is pinned rather than trusted — the cast is the point, standing in for a manifest built
     * against a newer schema than this app knows. */
    it(`still surfaces a contribution kind it has never been taught`, () => {
        expect(labels({ telemetry: [{ probe: `latency` }, { probe: `errors` }] } as unknown as ExtensionManifest["contributes"])).toEqual([
            `2 telemetry`,
        ]);
    });

    it(`says nothing at all for a manifest that contributes nothing`, () => {
        expect(labels(undefined)).toEqual([]);
    });
});

describe(`searchTextOf`, () => {
    // The filter has to find an extension by what it GIVES you, not only by the id it was published under —
    // nobody looking for the GitHub connector remembers it lives in `intentic.connectors`.
    it(`matches on a contributed card's catalog name, not just the extension id`, () => {
        const connectors = manifest({
            capabilities: [
                {
                    id: `github`,
                    kind: `cli`,
                    catalog: { name: `GitHub`, description: `Issues and PRs`, category: `code` },
                    fields: [{ key: `token`, label: `Token`, secret: true }],
                    env: { GITHUB_TOKEN: `\${token}` },
                    skill: `skills/github/SKILL.md`,
                },
            ],
        });
        expect(searchTextOf(connectors, facetsOf(connectors))).toContain(`github`);
    });
});
