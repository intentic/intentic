import { errorMessage } from "@intentic/base/errors";
import type { ExtensionServerApi } from "@intentic/extension-api";

// What the sandbox's own ChatGPT project is called after ("Intentic · <name>"): the name the owner gave the sandbox, as
// the platform last told it, else the sandbox's own name, else "sandbox". The project is found again by this name, so
// it is read the way the daemon read it while the kit lived there.

type Daemon = Pick<ExtensionServerApi, "daemon" | "log">;

const named = (name: string | undefined): string | undefined => (name === undefined || name === "" ? undefined : name);

// A name that cannot be read falls to the next one; the project is found again by name either way.
const readName = async (api: Daemon, what: string, read: () => Promise<string | undefined>): Promise<string | undefined> => {
    try {
        return named(await read());
    } catch (error) {
        api.log(`chatgpt: the sandbox's ${what} could not be read for the project's name: ${errorMessage(error)}`);
        return undefined;
    }
};

export const sandboxNameOf = async (api: Daemon): Promise<string> =>
    (await readName(api, "presentation", async () => (await api.daemon.rpc.system.presentation()).presentation?.name)) ??
    (await readName(api, "info", async () => (await api.daemon.rpc.system.info()).name)) ??
    "sandbox";
