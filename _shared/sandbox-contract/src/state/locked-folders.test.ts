import { holdsLockedWorkspacePath } from "./locked-folders.js";
import { PLAN_DOCUMENTS_DIR } from "./workspace-state.js";

// The folders the lock reaches through: deleting or moving one would carry the locked entries inside it.
describe(`holdsLockedWorkspacePath`, () => {
    it(`holds the root state dir and every group in it, whichever slash`, () => {
        expect(
            [`.intentic`, `./.intentic/`, `.intentic/config`, `.intentic/identity`, `.intentic/secrets`, `.intentic/records`, `.intentic\\local`].map(
                holdsLockedWorkspacePath,
            ),
        ).toEqual([true, true, true, true, true, true, true]);
    });

    it(`leaves ordinary state, the locked entries themselves, and anyone else's .intentic alone`, () => {
        expect(
            [
                `.intentic/config/approvals`,
                `.intentic/records/artifacts`,
                PLAN_DOCUMENTS_DIR,
                `.intentic/secrets/auth`,
                `.intentic/records/sessions`,
                `myrepo/.intentic`,
                `.git`,
                ``,
                `src`,
            ].map(holdsLockedWorkspacePath),
        ).toEqual([false, false, false, false, false, false, false, false, false]);
    });
});
