import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Services } from "../composition.js";
import { connectedTranslatorProviders, translatorWanted } from "../agent/translator.js";
import { packFragment } from "./packs.js";

/* THE PACKS A CONNECTED PROVIDER ASKS FOR, the provider-side counterpart to capabilityFragments.
 *
 * A capability's fragment rides an explicit install: the owner adds the capability, and the overlay grows. The
 * three helpers here have no capability to add. `codex`, `opencode` and `cli-proxy-api` are binaries a PROVIDER
 * needs, and the provider is turned on by connecting an account, so the fragment has to follow the credential
 * instead, or connecting a ChatGPT subscription on a core image would leave a Codex the sandbox cannot run and
 * nothing anywhere saying which rebuild would fix it.
 *
 * Nothing here is conditional on the STANDARD image, and that is packFragment's doing rather than a check: it
 * returns undefined for a pack the running base already bakes, so on the published image every predicate below
 * can be true and the overlay still comes out empty. The predicates decide what the sandbox WANTS; the pack
 * stamp decides whether wanting it costs a rebuild.
 *
 * CONNECTED IS READ FROM DISK, never from the helper it would start. Each of these credentials is stored by
 * something the pack itself installs, the translator holds its own subscriptions, OpenCode holds the xAI OAuth
 *, so asking the running helper is circular exactly where the answer matters: on a core image the binary is
 * absent, every live probe answers "nothing connected", and the pack would be kept out of the rebuild that
 * installs it. The stores outlive the binaries (they are on the auth volume), so the files are the truth. */

// A Codex turn is served by the ChatGPT subscription the translator holds, or, on a bare dev run, by the
// container's OPENAI_API_KEY. Either way the turn spawns the `codex` CLI, so either one wants the pack. This is
// the same reachability test planCodexTurn and the shell-delegation note gate on.
export const codexConnected = async (services: Services): Promise<boolean> =>
    services.config.openaiApiKey !== "" || (await connectedTranslatorProviders(services.authRoot)).has("codex");

/* A Cursor turn needs `@cursor/sdk`, which is the one runtime here that can NEVER be baked into a published
 * image: its licence grants no redistribution (see packs/cursor.Dockerfile). So this predicate is not merely
 * how the pack arrives on a core image, as it is for the three above, it is the ONLY way the pack ever arrives
 * anywhere, and a user who connects a Cursor account and is not offered the rebuild has no other route.
 *
 * Read off the credential DIRECTORY rather than through the store's parser, for the reason the module header
 * gives: a live probe would need the very module the pack installs. A directory with an account file in it is
 * the fact on disk, and it survives the binary being absent. */
const cursorConnected = async (services: Services): Promise<boolean> => {
    const entries = await readdir(join(services.authRoot, "cursor")).catch(() => [] as string[]);
    return entries.some((name) => name.endsWith(".json"));
};

export const providerPackFragments = async (services: Services): Promise<string[]> => {
    const [codex, cursor, grok, translator] = await Promise.all([
        codexConnected(services),
        cursorConnected(services),
        // OpenCode is the Grok credential store as well as its runtime, `connected` reads the auth.json a
        // device sign-in wrote, which is on disk whether or not a server is up.
        services.openCode.connected("xai"),
        translatorWanted(services),
    ]);
    const fragments = await Promise.all([
        ...(codex ? [packFragment("codex")] : []),
        ...(cursor ? [packFragment("cursor")] : []),
        ...(grok ? [packFragment("opencode")] : []),
        ...(translator ? [packFragment("translator")] : []),
    ]);
    return fragments.filter((fragment) => fragment !== undefined);
};
