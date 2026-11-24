import { leanRustEnv, rustIncrementalEnv } from "./turn-env.js";

test("lean Rust builds ask for line tables in the dev and test profiles, and set nothing when off", () => {
    expect(leanRustEnv(true)).toEqual({ CARGO_PROFILE_DEV_DEBUG: "line-tables-only", CARGO_PROFILE_TEST_DEBUG: "line-tables-only" });
    expect(leanRustEnv(false)).toEqual({});
});

test("turning Rust incremental compilation off sets CARGO_INCREMENTAL=0, and nothing when left on", () => {
    expect(rustIncrementalEnv(true)).toEqual({ CARGO_INCREMENTAL: "0" });
    expect(rustIncrementalEnv(false)).toEqual({});
});
