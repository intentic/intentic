import { lingerFile, lingerMarkerPath } from "./linger.js";

/* Where lingering is read from and where an agent records turning it on. Pure: nothing here asks logind. */

test("a user's lingering is logind's file named for them", () => {
    expect(lingerFile("dev")).toBe("/var/lib/systemd/linger/dev");
});

test("the marker sits in the agent's own folder, beside its log, so it goes with the agent", () => {
    expect(lingerMarkerPath({ logPath: "/home/dev/.intentic/machine/machine.log" })).toBe("/home/dev/.intentic/machine/linger-enabled");
    expect(lingerMarkerPath({ logPath: "/home/dev/.intentic/keyring/keyring.log" })).toBe("/home/dev/.intentic/keyring/linger-enabled");
});
