// Single existence check for the whole daemon. Uses `access`, not `stat`: it answers whether something is reachable,
// not what shape it is, so a permission-denied path reads as absent, not distinct from missing.
import { access } from "node:fs/promises";

export const pathExists = async (path: string): Promise<boolean> =>
    access(path).then(
        () => true,
        () => false,
    );
