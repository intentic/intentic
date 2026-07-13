import type { ExtensionContext, IntenticApi, ViewerRegistration } from "@intentic/extension-api";
import * as viewers from "@intentic/ext-viewers";
import { describe, expect, it } from "vitest";

/* Exercises the ext-viewers package the way loadBuiltins does — activate() against a minimal fake IntenticApi —
 * proving it registers the docx + xlsx custom viewers declared in its manifest. This is the end-to-end wiring of
 * the contributes.viewers path (manifest → activate → api.viewers.register), minus the browser render. */

const activateAndCaptureViewers = (): ViewerRegistration[] => {
    const registered: ViewerRegistration[] = [];
    const api = {
        viewers: { register: (viewer: ViewerRegistration) => (registered.push(viewer), { dispose: () => {} }) },
    } as unknown as IntenticApi;
    viewers.activate(api, { extensionId: `test`, subscriptions: [] });
    return registered;
};

describe(`ext-viewers`, () => {
    it(`registers the docx and xlsx viewers`, () => {
        const ids = activateAndCaptureViewers()
            .map((viewer) => viewer.id)
            .sort();
        expect(ids).toEqual([`docx`, `xlsx`]);
    });

    it(`declares each viewer in the manifest with its file extension and fetch kind`, () => {
        expect(viewers.manifest.contributes?.viewers).toEqual([
            { id: `docx`, extensions: [`docx`], fetch: `blob` },
            { id: `xlsx`, extensions: [`xlsx`], fetch: `blob` },
        ]);
    });

    it(`registers only viewer ids the manifest declares (the host gates the rest)`, () => {
        const declared = new Set((viewers.manifest.contributes?.viewers ?? []).map((viewer) => viewer.id));
        for (const viewer of activateAndCaptureViewers()) {
            expect(declared.has(viewer.id)).toBe(true);
        }
    });
});
