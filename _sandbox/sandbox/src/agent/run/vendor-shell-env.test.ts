import { vendorShellEnv } from "./vendor-shell-env.js";

// A vendor runtime's login shell (Codex runs `bash -lc`) loses PATH to /etc/profile; the daemon's PATH rides
// INTENTIC_LOGIN_PATH, which the image's profile.d script puts back. 67 "pnpm: command not found" made this.

test("the PATH a vendor shell gets is carried for its login shell too, with or without a heavy table", async () => {
    expect(await vendorShellEnv({}, { PATH: "/a/bin:/usr/bin" })).toEqual({ INTENTIC_LOGIN_PATH: "/a/bin:/usr/bin" });
    const unreadable = await vendorShellEnv({ heavyCommands: () => Promise.reject(new Error("unreadable")) }, { PATH: "/b/bin" });
    expect(unreadable).toEqual({ INTENTIC_LOGIN_PATH: "/b/bin" });
});

test("no PATH to carry carries nothing", async () => {
    expect(await vendorShellEnv({}, {})).toEqual({});
});
