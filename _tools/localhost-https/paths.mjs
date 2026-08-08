/* Where the development CA and this checkout's leaf live.
 *
 * THE CA IS PER MACHINE, NOT PER CHECKOUT. It is the thing you put in a trust store, and a trust store is a
 * property of the machine — so a root that lived beside the code would mean re-approving a browser warning for
 * every clone, every worktree and every sandbox workspace on the same laptop. It sits in the OS's own per-user
 * data directory instead, and every checkout signs its leaf with it.
 *
 * THE LEAF IS PER CHECKOUT, beside this file, because that is where the API and Vite already read it from
 * (`node_modules/@intentic-app/localhost-https/localhost.crt`). It is signed by the shared root, so a leaf a
 * fresh clone mints is trusted the moment it exists.
 */
import { homedir } from "node:os";
import { join } from "node:path";

const machineDir = () => {
    const home = homedir();
    if (process.platform === `win32`) {
        return join(process.env.LOCALAPPDATA ?? join(home, `AppData`, `Local`), `intentic`, `localhost-https`);
    }
    if (process.platform === `darwin`) {
        return join(home, `Library`, `Application Support`, `intentic`, `localhost-https`);
    }
    return join(process.env.XDG_DATA_HOME ?? join(home, `.local`, `share`), `intentic`, `localhost-https`);
};

export const CA_DIR = machineDir();
export const CA_KEY = join(CA_DIR, `localhost-com-ca.key`);
export const CA_CRT = join(CA_DIR, `localhost-com-ca.crt`);

export const LEAF_KEY = join(import.meta.dirname, `localhost.key`);
export const LEAF_CRT = join(import.meta.dirname, `localhost.crt`);

// The name the root goes into a trust store under, so `cert:trust` can find and replace its own earlier entry
// rather than stacking duplicates.
export const CA_NICKNAME = `intentic development`;
