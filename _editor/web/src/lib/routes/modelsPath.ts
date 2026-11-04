import { legacyPathOf } from "@intentic/sandbox-contract/app-routes";
import { here, page } from "./links";

// Where this sandbox's models are connected and managed: Sandbox ▸ Models. One address for every door to it (the chat's
// strip, the model picker, setup's landing, a job whose model is not connected) so none of them can drift onto an older
// one. `/connect` was its own page until 2026-10; it redirects here, query and all, for links out of older builds. Made
// in the reader's own frame and sandbox (links.ts `here`), so a door pressed on Home stays on Home
// (lib/routes/homeDetour.ts shows it in the chat's place there).

/**
 * The page's address in the form addresses had before frames, for a door that names it once as a constant; the router
 * opens it in the frame it is pressed in. A new door uses `modelsPath()`.
 */
export const MODELS_PATH = legacyPathOf(page.sandboxSettings(`models`));

// What a link may ask of the page: `provider` starts that provider's sign-in where nothing of it is connected yet
// (linkArrival), `open` only opens a tile (a provider's own, by its id) for the reader to choose how to connect, and
// `found` is what the desktop app found signed in on this computer (lib/foundOnComputer.ts).
export interface ModelsQuery {
    readonly provider?: string;
    readonly open?: string;
    readonly found?: string;
}

/** The page's address where the reader is, carrying only the parts of a request that say something. */
export const modelsHref = (query: ModelsQuery = {}): string => here(page.sandboxSettings(`models`, { query: { ...query } }));

// The same address, for the places that hand the router a location.
export const modelsPath = (query: ModelsQuery = {}): string => modelsHref(query);
