import { STATE_DIR } from "@intentic/constants";
// @vitest-environment jsdom
import type { FileContribution } from "@intentic/extension-manifest";
import { staleQueryKeys } from "@intentic/sandbox-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { contributedFileBindings, registerFileBindings } from "./fileBindings";

/* The browser half of the file→view table: the registry the host writes activated extensions' `contributes.files`
 * into, and the union systemEvents feeds every `workspaceChanged` frame through. */

// Same reason as builtins.test.ts: the builtins list's import chain pulls app-wide singletons that read browser
// globals at module scope: hence jsdom, and the globals vitest.setup.ts installs for the package.

const { builtinModules } = await import("./builtins");

const AUTOMATIONS_FILES: readonly FileContribution[] = [{ path: `${STATE_DIR}/config/automations.json`, invalidates: [`automations`] }];

describe(`registerFileBindings`, () => {
    // The registry is module state, so each test has to start from empty or ordering decides the result.
    beforeEach(() => {
        for (const owner of [`a.one`, `a.two`]) {
            registerFileBindings(owner, []).dispose();
        }
    });

    it(`unions the bindings of every registered extension`, () => {
        registerFileBindings(`a.one`, AUTOMATIONS_FILES);
        registerFileBindings(`a.two`, [{ path: `${STATE_DIR}/records/approvals/`, invalidates: [`automation-approvals`] }]);
        expect(contributedFileBindings().map((file) => file.path)).toEqual([`.intentic/config/automations.json`, `.intentic/records/approvals/`]);
    });

    it(`replaces an extension's bindings on re-registration instead of doubling them`, () => {
        // A re-activation (dev-server hot reload, a reload after install) runs the host chain again against a
        // registry that kept its instance. Appending would bill every future push twice per reload.
        registerFileBindings(`a.one`, AUTOMATIONS_FILES);
        registerFileBindings(`a.one`, AUTOMATIONS_FILES);
        expect(contributedFileBindings()).toHaveLength(1);
    });

    it(`ignores a superseded activation's late dispose`, () => {
        // The disposable a retired activation holds must not evict the replacement that took its place.
        const stale = registerFileBindings(`a.one`, AUTOMATIONS_FILES);
        registerFileBindings(`a.one`, [{ path: `${STATE_DIR}/config/approvals/`, invalidates: [`approvals`] }]);
        stale.dispose();
        expect(contributedFileBindings().map((file) => file.path)).toEqual([`.intentic/config/approvals/`]);
    });

    it(`drops an extension's bindings when its own registration is disposed`, () => {
        const live = registerFileBindings(`a.one`, AUTOMATIONS_FILES);
        live.dispose();
        expect(contributedFileBindings()).toEqual([]);
    });
});

describe(`the builtins' declared bindings`, () => {
    /* The regression ③ closed. `.intentic/config/automations.json` and `.intentic/records/approvals/` are written by the DAEMON's
     * automations store and rendered by the automations EXTENSION, and the core table used to carry the
     * extension's two query keys itself because the extension had no way to declare them. Asserted against the
     * real manifests, not a fixture: the point is that the shipped declaration is the thing that works. */
    const bindings = [...builtinModules.values()].flatMap((module) => module.manifest.contributes?.files ?? []);

    it(`refreshes the Automations view when the agent edits the manifest on disk`, () => {
        expect(staleQueryKeys([`.intentic/config/automations.json`], bindings)).toEqual([`automations`]);
        expect(staleQueryKeys([`.intentic/records/approvals/pending-1.json`], bindings)).toEqual([`automation-approvals`]);
    });

    it(`leaves those keys entirely to the extension`, () => {
        // With no extension running the same write makes nothing stale: the core table no longer reaches across
        // the boundary for keys it does not query.
        expect(staleQueryKeys([`.intentic/config/automations.json`, `.intentic/records/approvals/pending-1.json`], [])).toEqual([]);
    });
});
