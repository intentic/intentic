import { SANDBOX_ROUTE_SHAPES } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";

// Why a dev sandbox drifts from a dev browser without either being "older": this app bundles the contract from its
// TypeScript source, the daemon loads the compiled dist, and only the first of those follows an edit immediately. So an
// uncompiled contract change reads, to every version check there is, as two builds disagreeing — and the one remedy
// that looks cheapest, reloading the page, cannot fix it.
//
// This app is the source side by construction, so it only needs the compiled one, which the dev server hands over. The
// diff is then between the same two artifacts the sandbox's own drift check compares. Production ships both sides
// compiled and serves no such endpoint, which leaves this undefined: no evidence, not "fine".

const ENDPOINT = `/contract-freshness.json`;

// Undefined until the dev server has answered; an empty array is a positive "the compiled contract matches source".
const uncompiled = ref<readonly string[] | undefined>(undefined);

export const uncompiledRoutes = computed<readonly string[]>(() => uncompiled.value ?? []);

// True only on the dev server's word. Read by the drift messages to replace a guess about which side moved with the
// cause, and to drop the page reload from the offered remedies.
export const contractUncompiled = computed(() => uncompiledRoutes.value.length > 0);

// Asked once per page, and only when something already disagrees: it costs the dev server a contract load, and there
// is nothing to say while the two sides agree.
let asked: Promise<void> | undefined;

export const readContractFreshness = async (): Promise<void> => {
    if (!import.meta.env.DEV) {
        return;
    }
    asked ??= (async () => {
        try {
            const response = await fetch(ENDPOINT, { headers: { accept: `application/json` } });
            if (!response.ok) {
                return;
            }
            const body = (await response.json()) as { compiled?: Record<string, string> };
            const compiled = body.compiled;
            if (typeof compiled !== `object` || compiled === null) {
                return;
            }
            // Both directions: a route only source has is as much an uncompiled edit as one whose shape moved.
            const names = new Set([...Object.keys(SANDBOX_ROUTE_SHAPES), ...Object.keys(compiled)]);
            uncompiled.value = [...names].filter((name) => compiled[name] !== SANDBOX_ROUTE_SHAPES[name]).toSorted();
        } catch {
            // A dev server that cannot answer leaves the question open, which is what `undefined` already says.
        }
    })();
    return asked;
};

// Test seam: the answer is about this checkout's contract, not about a sandbox, so nothing resets it on a switch, but a
// test that pins one message must not leak it into the next.
export const resetContractFreshness = (routes?: readonly string[]): void => {
    uncompiled.value = routes;
    asked = routes === undefined ? undefined : Promise.resolve();
};
