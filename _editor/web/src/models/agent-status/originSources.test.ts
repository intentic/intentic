import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { type ExtensionManifest, ExtensionManifestSchema } from "@intentic/extension-manifest";
import { originMeta } from "./agentStatus-meta";
import { listenerOrigins } from "./originSources";
import { sessionKind } from "./sessionKind";

// A conversation an extension's listener opened is named by that listener's own declaration and drawn with its
// extension's mark, read off the in-repo manifests as the daemon serves them; nothing in the editor lists providers.

const inRepo = (name: string): ExtensionManifest =>
    ExtensionManifestSchema.parse(JSON.parse(readFileSync(join(repoRoot(import.meta.url), `_extensions`, name, `intentic-extension.json`), `utf8`)));

const LISTENERS = listenerOrigins([`discord`, `slack`, `imap`, `microsoft-365`, `social`].map(inRepo));

describe(`an origin from an extension's listener`, () => {
    it(`is named as the listener declares it, with its extension's logo or icon`, () => {
        expect(originMeta({ automationId: `team`, provider: `discord`, author: `ada` }, LISTENERS)).toMatchObject({
            label: `Discord`,
            logo: `discord`,
            icon: `comments`,
            detail: `ada`,
        });
        expect(originMeta({ automationId: `mail`, provider: `imap` }, LISTENERS)).toMatchObject({ label: `Email (IMAP)`, icon: `envelope` });
        expect(originMeta({ automationId: `mail`, provider: `microsoft365` }, LISTENERS)).toMatchObject({ label: `Microsoft 365`, icon: `envelope` });
        // An extension without a listener supplies no source.
        expect([...LISTENERS.keys()].toSorted()).toEqual([`discord`, `imap`, `microsoft365`, `slack`]);
    });

    it(`falls back to its own name when no enabled extension declares it, and the sandbox's own sources keep their words`, () => {
        expect(originMeta({ automationId: `team`, provider: `discord` })).toMatchObject({ label: `discord`, icon: `wave-pulse` });
        expect(originMeta({ automationId: `nightly`, provider: `schedule` }, LISTENERS).icon).toBe(`clock`);
    });

    it(`draws the session tile with the listener's glyph`, () => {
        expect(sessionKind({ id: `a-1`, origin: { automationId: `mail`, provider: `imap` } }, LISTENERS)).toMatchObject({ name: `automation`, icon: `envelope` });
    });
});
