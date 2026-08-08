/* Where the development root and the certificate under it live.
 *
 * BOTH LIVE OUTSIDE THE REPOSITORY, TOGETHER, in the OS's own per-user data directory — and the two halves of
 * that sentence fix two different bugs.
 *
 * OUTSIDE, because the root is the thing you put in a trust store, and a trust store belongs to a machine. A
 * root that lived beside the code would mean re-approving a browser warning for every clone, worktree and
 * sandbox workspace on the same laptop.
 *
 * TOGETHER, because a certificate is worthless without the root that signed it, and keeping the certificate in
 * the repository while the root moved out made them separable in the one way that matters. A workspace folder is
 * shared with every container mounted on it; each container has its own home directory, so each resolves its own
 * root. One agent running the installer inside a sandbox minted a root in the container, re-signed the
 * certificate in the shared folder with it, and left the host's dev server serving a chain whose root died with
 * the container — a browser warning with nothing on the machine able to explain it. Now a container writes only
 * its own pair in its own home, and the host's is untouched.
 *
 * The consequence is that no consumer can hardcode the location any more, since it differs per user and per OS.
 * Vite, the API and the tests import these constants instead; nothing writes a certificate into this package.
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

export const LEAF_KEY = join(CA_DIR, `localhost.key`);
export const LEAF_CRT = join(CA_DIR, `localhost.crt`);

// The name the root goes into a trust store under, so `cert:trust` can find and replace its own earlier entry
// rather than stacking duplicates.
export const CA_NICKNAME = `intentic development`;
