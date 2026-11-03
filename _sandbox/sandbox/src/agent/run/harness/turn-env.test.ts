import { leanRustEnv } from "./turn-env.js";

test("lean Rust builds ask for line tables in the dev and test profiles, and set nothing when off", () => {
    expect(leanRustEnv(true)).toEqual({ CARGO_PROFILE_DEV_DEBUG: "line-tables-only", CARGO_PROFILE_TEST_DEBUG: "line-tables-only" });
    expect(leanRustEnv(false)).toEqual({});
});
