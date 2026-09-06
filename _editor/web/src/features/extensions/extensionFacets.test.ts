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
        const views = [
            { id: `docs`, label: `Documentation`, surface: `rail` as const },
            { id: `repo`, label: `Docs`, surface: `directory` as const },
            { id: `other`, label: `More docs`, surface: `directory` as const },
        ];
        const facets = facetsOf(manifest({ views }));
        const rail = facets.find((facet) => facet.names.includes(`Documentation`));
        const directory = facets.find((facet) => facet.names.includes(`Docs`));
        expect(rail?.names).toEqual([`Documentation`]);
        expect(directory?.names).toEqual([`Docs`, `More docs`]);
    });

    it(`carries the real names, not counts, for the expanded breakdown`, () => {
        const [facet] = facetsOf(manifest({ commands: [{ command: `documentation.generate`, title: `Generate documentation` }] }));
        expect(facet).toEqual({ kind: `commands`, label: `command`, names: [`Generate documentation`], surface: true });
    });

    it(`keeps wiring out of the one-line strip but not out of the record`, () => {
        const [facet] = facetsOf(manifest({ files: [{ path: `${STATE_DIR}/config/docs/`, invalidates: [`documentation`] }] }));
        expect(facet).toMatchObject({ kind: `files`, names: [`.intentic/config/docs/`], surface: false });
    });

    it(`skips a declared-but-empty array rather than saying "0 commands"`, () => {
        const facets = facetsOf(manifest({ commands: [], views: [{ id: `docs`, label: `Documentation`, surface: `sandbox` }] }));
        expect(facets).toHaveLength(1);
        expect(facets[0]?.names).toContain(`Documentation`);
    });

    /* The property the old counts line was written for and this one has to keep: a contribution point added to
     * the schema must show up WITHOUT an edit here. The enumerated version that preceded it silently omitted six
     * kinds, so this is pinned rather than trusted: the cast is the point, standing in for a manifest built
     * against a newer schema than this app knows. */
    it(`still surfaces a contribution kind it has never been taught`, () => {
        const probes = [{ probe: `latency` }, { probe: `errors` }];
        const facets = facetsOf(
            manifest({ telemetry: probes } as unknown as ExtensionManifest["contributes"]),
        );
        expect(facets[0]?.kind).toBe(`telemetry`);
        expect(facets[0]?.label).toMatch(new RegExp(`^${probes.length} `));
    });

    it(`says nothing at all for a manifest that contributes nothing`, () => {
        expect(labels(undefined)).toEqual([]);
    });
});

describe(`searchTextOf`, () => {
    // The filter has to find an extension by what it GIVES you, not only by the id it was published under:
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
