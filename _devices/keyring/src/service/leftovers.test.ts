import { othersHardened } from "./leftovers.js";

/* Whether the shared parts of hardened mode (the service's program, the root folder, the task folder) may go: only when
   no other user of the PC still has a hardened keyring, read off the markers beside the root. */

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const OTHER = "S-1-5-21-1111111111-2222222222-3333333333-1002";

test("the last hardened user's uninstall may take the shared parts", () => {
    expect(othersHardened(["bin", SID, `${SID}.door.json`], SID)).toBe(false);
    expect(othersHardened(["bin", `${SID}.hardened`], SID)).toBe(false);
});

test("another user's marker keeps them, whatever case Windows lists it in", () => {
    expect(othersHardened(["bin", `${OTHER}.hardened`], SID)).toBe(true);
    expect(othersHardened(["bin", `${OTHER}.HARDENED`], SID)).toBe(true);
});

test("this user's own marker, in any case, is not another user's", () => {
    expect(othersHardened([`${SID.toLowerCase()}.hardened`], SID)).toBe(false);
});
