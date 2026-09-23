// Pins what the form's effects panel and the grid's badges read: the contribution a config names through its kind's
// discriminator, the live answers (a typed name, a cloned URL) the panel follows, and the three consequences badged.
import { CAPABILITY_CATALOG, type CapabilityCatalogEntry, contributionEntry } from "@intentic/capability-catalog";
import type { CapabilityContribution } from "@intentic/extension-manifest";
import type { CapabilityKind } from "@intentic/sandbox-contract";
import { describe, expect, it, mock } from "bun:test";
import { contributionFor, formEffects, tileBadges } from "./effects";

// A connector with a credential and a client binary to bake in: the two facts only its contribution knows.
const POSTGRES: CapabilityContribution = {
    id: `postgres`,
    kind: `cli`,
    catalog: { name: `Postgres`, category: `data`, description: `Query your database.` },
    fields: [
        { key: `url`, label: `Connection URL` },
        { key: `password`, label: `Password`, secret: true },
    ],
    env: { PGURL: `\${url}` },
    skill: `skills/postgres/SKILL.md`,
    fragment: `RUN apt-get install -y postgresql-client`,
};
const postgres = contributionEntry(POSTGRES);
const catalogEntry = (id: string): CapabilityCatalogEntry => CAPABILITY_CATALOG.find((entry) => entry.id === id)!;

const contributionOf = (kind: CapabilityKind, id: string): CapabilityContribution | undefined =>
    kind === POSTGRES.kind && id === POSTGRES.id ? POSTGRES : undefined;

describe(`the contribution behind a config`, () => {
    it(`is named by the kind's discriminator, and a core kind has none to name`, () => {
        const asked = mock(contributionOf);

        expect(contributionFor(asked, `cli`, { provider: `postgres` })).toBe(POSTGRES);
        expect(contributionFor(asked, `cli`, {})).toBeUndefined();
        expect(contributionFor(asked, `vpn`, { provider: `wireguard` })).toBeUndefined();
        expect(asked.mock.calls).toEqual([
            [`cli`, `postgres`],
            [`cli`, ``],
        ]);
    });
});

describe(`the form's effects panel`, () => {
    it(`follows the typed name and the contribution's credential and image`, () => {
        expect(formEffects(postgres, { url: ` postgres://db `, password: `` }, ` shop-db `, contributionOf)).toEqual([
            { kind: `skill`, name: `shop-db` },
            { kind: `secret`, exposure: `agent-env` },
            { kind: `image` },
        ]);
        // Nothing typed yet names nothing; without its contribution a connector could promise no credential.
        expect(formEffects(postgres, {}, `  `, () => undefined)).toEqual([{ kind: `skill`, name: undefined }]);
    });

    it(`tracks a clone URL as it is typed`, () => {
        expect(formEffects(catalogEntry(`plugin`), { url: `https://github.com/acme/tools ` }, `tools`, contributionOf)).toEqual([
            { kind: `clone`, url: `https://github.com/acme/tools` },
        ]);
    });
});

describe(`the grid's badges`, () => {
    it(`badge only an image, a runtime privilege or trusted code, from the tile's defaults`, () => {
        expect(tileBadges(postgres, contributionOf)).toEqual([{ kind: `image` }]);
        expect(tileBadges(catalogEntry(`docker`), contributionOf)).toEqual([{ kind: `image` }, { kind: `runtime`, level: `privileged` }]);
        expect(tileBadges(catalogEntry(`extension`), contributionOf)).toEqual([{ kind: `trusted-code` }]);
        expect(tileBadges(catalogEntry(`ssh`), contributionOf)).toEqual([]);
    });
});
