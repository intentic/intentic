import type { RouteLocationRaw } from "vue-router";

// Where this sandbox's models are connected and managed: Sandbox ▸ Models. One address for every door to it (the chat's
// strip, the model picker, setup's landing, a job whose model is not connected) so none of them can drift onto an older
// one. `/connect` was its own page until 2026-10; it redirects here, query and all, for links out of older builds.

export const MODELS_PATH = `/sandbox/models`;

// What a link may ask of the page: `provider` starts that provider's sign-in where nothing of it is connected yet
// (linkArrival), `found` is what the desktop app found signed in on this computer (lib/foundOnComputer.ts).
export interface ModelsQuery {
    readonly provider?: string;
    readonly found?: string;
}

export const modelsPath = (query: ModelsQuery = {}): RouteLocationRaw => {
    const named = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== ``));
    return Object.keys(named).length === 0 ? MODELS_PATH : { path: MODELS_PATH, query: named };
};

// The same address as text, for the places that hold a plain href (a test's expectation, a string route).
export const modelsHref = (query: ModelsQuery = {}): string => {
    const named = Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ``);
    return named.length === 0 ? MODELS_PATH : `${MODELS_PATH}?${new URLSearchParams(named).toString()}`;
};
