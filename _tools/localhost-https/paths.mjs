// Dev root and leaf live outside the repo, in the OS's per-user data directory, and together. Outside: the root belongs
// to a trust store per machine, not per clone. Together: each container has its own home dir and mints or resigns its
// own pair, not a shared one. Vite, the API and tests import these constants; nothing hardcodes the path.
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

export const LEAF_KEY = join(CA_DIR, `localhost.key`);
export const LEAF_CRT = join(CA_DIR, `localhost.crt`);

// Trust-store entry name; lets cert:trust replace its own earlier entry instead of stacking duplicates.
export const CA_NICKNAME = `intentic development`;
