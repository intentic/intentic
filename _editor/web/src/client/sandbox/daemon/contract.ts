import { loadChunk } from "@intentic/ui/chunk";
import { shallowRef } from "vue";

// THE SANDBOX CONTRACT, LOADED BESIDE THE START RATHER THAN BEFORE IT. The contract is every route the daemon serves with
// its zod schemas: the largest single part of the app (~0.7 MB of the 3.3 MB a page loaded before it could run a line of
// main.ts), and all of it built at load. Nothing needs it until the first daemon call, which waits on the session, the
// sandbox list and the shell anyway, so main.ts starts this import first thing and the calls await it (../sandboxRpc.ts).
// Readers that answer synchronously (route drift, ../useDaemonRoutes.ts) read `contractModule`, undefined until it lands,
// and treat that as having no evidence yet. It is the same module the static import was, so every answer once it lands
// is exactly what it was.
export type ContractModule = typeof import("@intentic/sandbox-contract");

// allow(module-state): the one loaded contract, the same for every sandbox and every window lifetime
export const contractModule = shallowRef<ContractModule | undefined>(undefined);

let loading: Promise<ContractModule> | undefined;

const load = async (): Promise<ContractModule> => {
    try {
        const module = await loadChunk(() => import(`@intentic/sandbox-contract`));
        contractModule.value = module;
        return module;
    } catch (error) {
        // A later call loads again rather than replaying this failure; a dead chunk has already reloaded the page.
        loading = undefined;
        throw error;
    }
};

/** The contract module, loading it on the first call; a failed load (a dead chunk after a deploy) is retried next call. */
export const loadContract = (): Promise<ContractModule> => {
    loading ??= load();
    return loading;
};
