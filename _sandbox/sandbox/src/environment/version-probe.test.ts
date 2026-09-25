import { clearVersionCache, probePackages, queryDpkg } from "./version-probe.js";

// A package query that did not answer is never remembered, the same rule probeVersion keeps for a timed-out binary: one
// busy moment must not report an installed package as missing for the next five minutes.

afterEach(() => clearVersionCache());

test("an answered query is cached: the next probe within the window asks nothing", async () => {
    let asked = 0;
    const query = async () => {
        asked += 1;
        return { stdout: "imagemagick|ii |8:7.1.1.43+dfsg1-1\n", answered: true };
    };
    expect(await probePackages(["imagemagick"], query)).toEqual(new Map([["imagemagick", { version: "7.1.1", found: true, at: expect.any(Number) }]]));
    await probePackages(["imagemagick"], query);
    expect(asked).toBe(1);
});

test("a query that timed out or failed is read for this call only, and asked again on the next", async () => {
    let asked = 0;
    const query = async () => {
        asked += 1;
        return { stdout: "", answered: false };
    };
    expect((await probePackages(["sysstat"], query)).get("sysstat")).toMatchObject({ version: undefined, found: false });
    await probePackages(["sysstat"], query);
    expect(asked).toBe(2);
});

test("dpkg's own exit for an unknown name is an answer; a kill at the timeout or no answer at all is not", async () => {
    const failing = (error: object) => (async () => { throw Object.assign(new Error("dpkg-query"), error); }) as unknown as Parameters<typeof queryDpkg>[1];
    expect(await queryDpkg(["nope"], failing({ code: 1, killed: false, stdout: "" }))).toEqual({ stdout: "", answered: true });
    expect(await queryDpkg(["x"], failing({ code: "ENOENT" }))).toEqual({ stdout: "", answered: true });
    expect(await queryDpkg(["x"], failing({ code: null, killed: true, signal: "SIGTERM", stdout: "x|ii |1\n" }))).toEqual({ stdout: "x|ii |1\n", answered: false });
    expect(await queryDpkg(["x"], failing({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }))).toEqual({ stdout: "", answered: false });
});
