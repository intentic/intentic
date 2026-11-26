import { extensionIdOf } from "@intentic/extension-manifest";
import { type ExtensionHost, enabledExtensions } from "../capabilities/extension-inventory/installed-extensions.js";
import type { CiStore } from "./ci-store.js";

/* WHO TAKES MAIN'S FAILURES (2026-11-26). Main's one fix agent is an extension's (the pipelines extension's, whose
   `autoRepair` setting decides), so whether a main line's failure is that agent's alone is the extension's to say: it
   claims main lines (POST /ci/main-lines/claim) while repairs are on, and lets go when they are off. While a claim of an
   extension that is switched on stands, a failure on a main line reaches no `ci` automation listening on every branch
   (events.ts), so the "Fix failing CI" template cannot start a second agent pushing to main; an automation that names
   the branch still hears it. Kept in the CI store, so a restart does not open a window where a failure reaches both
   before the extension's backend is back; an extension switched off holds none, whatever the store says. Until then the
   daemon read its own `autoRepair` setting here. */

export type ClaimServices = { readonly ciStore: Pick<CiStore, "mainLineClaims"> } & ExtensionHost;

/** Whether an extension that is switched on claims main lines' failures now. */
export const mainLinesClaimed = async (services: ClaimServices): Promise<boolean> => {
    const claims = await services.ciStore.mainLineClaims();
    if (claims.length === 0) {
        return false;
    }
    return (await enabledExtensions(services)).some((extension) => claims.includes(extensionIdOf(extension.manifest)));
};
