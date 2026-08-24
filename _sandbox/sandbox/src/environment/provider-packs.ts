import type { Services } from "../composition.js";
import { providerPackWants } from "../agent/provider-registry.js";
import { translatorWanted } from "../agent/translator.js";
import { packFragment } from "./packs.js";

/* THE PACKS A CONNECTED PROVIDER ASKS FOR, the provider-side counterpart to capabilityFragments.
 *
 * A capability's fragment rides an explicit install: the owner adds the capability, and the overlay grows. The
 * helpers here have no capability to add. `codex`, `cursor`, `opencode` and `cli-proxy-api` are runtimes a
 * PROVIDER needs, and the provider is turned on by connecting an account, so the fragment has to follow the
 * credential instead, or connecting a subscription on a core image would leave a runtime the sandbox cannot
 * run and nothing anywhere saying which rebuild would fix it.
 *
 * WHICH packs each provider wants is the provider's own declaration now (its module's `packs`, iterated by the
 * registry): a provider that ships a pack and forgets to want it is a registry omission this file can no
 * longer contain. What stays HERE is the translator, because it is nobody's pack — one binary serves the
 * ChatGPT, Kimi and Google subscriptions and every openai-protocol endpoint, so no single module may own it.
 *
 * Nothing here is conditional on the STANDARD image, and that is packFragment's doing rather than a check: it
 * returns undefined for a pack the running base already bakes, so on the published image every want below can
 * be real and the overlay still comes out empty. The predicates decide what the sandbox WANTS; the pack stamp
 * decides whether wanting it costs a rebuild.
 *
 * CONNECTED IS READ FROM DISK, never from the helper it would start (each module's `packs` holds to this).
 * Each of these credentials is stored by something the pack itself installs, so asking the running helper is
 * circular exactly where the answer matters: on a core image the binary is absent, every live probe answers
 * "nothing connected", and the pack would be kept out of the rebuild that installs it. The stores outlive the
 * binaries (they are on the auth volume), so the files are the truth. */
export const providerPackFragments = async (services: Services): Promise<string[]> => {
    const [wants, translator] = await Promise.all([providerPackWants(services), translatorWanted(services)]);
    const names = [...wants, ...(translator ? ["translator"] : [])];
    const fragments = await Promise.all(names.map((name) => packFragment(name)));
    return fragments.filter((fragment): fragment is string => fragment !== undefined);
};
