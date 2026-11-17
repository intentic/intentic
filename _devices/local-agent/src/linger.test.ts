import { lingerArgs, lingerFile, lingerMarkerPath } from "./linger.js";

/* Where lingering is read from and where an agent records turning it on. Pure: nothing here asks logind. */

test("a user's lingering is logind's file named for them", () => {
    expect(lingerFile("dev")).toBe("/var/lib/systemd/linger/dev");
});

test("the marker sits in the agent's own folder, beside its log, so it goes with the agent", () => {
    expect(lingerMarkerPath({ logPath: "/home/dev/.intentic/machine/machine.log" })).toBe("/home/dev/.intentic/machine/linger-enabled");
    expect(lingerMarkerPath({ logPath: "/home/dev/.intentic/keyring/keyring.log" })).toBe("/home/dev/.intentic/keyring/linger-enabled");
});

// (2026-11-17) Without a user, loginctl acts for the caller's SESSION user: root in a `su -l` inside an ssh login turned
// lingering on for the ssh user instead of itself. The process's own user is always named.
test("loginctl is told whose lingering to change, never left to read it off the session", () => {
    expect(lingerArgs("enable-linger", "root")).toEqual(["enable-linger", "root"]);
    expect(lingerArgs("disable-linger", "dev")).toEqual(["disable-linger", "dev"]);
    // A user the system cannot name leaves loginctl its own default, as before.
    expect(lingerArgs("enable-linger", undefined)).toEqual(["enable-linger"]);
});
