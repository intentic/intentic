import { STATE_DIR } from "@intentic/constants";
// @vitest-environment jsdom
import type { FileContribution } from "@intentic/extension-manifest";
import { staleQueryKeys } from "@intentic/sandbox-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { contributedFileBindings, registerFileBindings } from "./fileBindings";

// Registry of extensions' contributes.files bindings; contributedFileBindings() feeds workspaceChanged invalidation via
// systemEvents.

// jsdom: builtins' import chain pulls app-wide singletons that read browser globals at module scope.

const { builtinModules } = await import("./builtins");

const AUTOMATIONS_FILES: readonly FileContribution[] = [{ path: `${STATE_DIR}/config/automations.json`, invalidates: [`automations`] }];

describe(`registerFileBindings`, () => {
    // Registry is module state; reset before each test so order doesn't decide the result.
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
        // Re-activation reuses the registry instance; appending on re-registration would double future pushes.
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
    // Built from the real shipped manifests, not a fixture, so the test proves the shipped declaration works.
    const bindings = [...builtinModules.values()].flatMap((module) => module.manifest.contributes?.files ?? []);

    it(`refreshes the Automations view when the agent edits the manifest on disk`, () => {
        expect(staleQueryKeys([`.intentic/config/automations.json`], bindings)).toEqual([`automations`]);
        expect(staleQueryKeys([`.intentic/records/approvals/pending-1.json`], bindings)).toEqual([`automation-approvals`]);
    });

    it(`leaves those keys entirely to the extension`, () => {
        // With no extension registered, the write yields nothing stale; the core table owns no keys itself.
        expect(staleQueryKeys([`.intentic/config/automations.json`, `.intentic/records/approvals/pending-1.json`], [])).toEqual([]);
    });
});
