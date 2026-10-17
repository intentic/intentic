import { untranslatedEnv } from "./untranslated-env.js";

describe("untranslatedEnv", () => {
    it("pins messages to C and leaves every other category as it was", () => {
        expect(untranslatedEnv({ PATH: "/bin", LANG: "pl_PL.UTF-8", LANGUAGE: "pl:en", LC_TIME: "de_DE.UTF-8" })).toEqual({
            PATH: "/bin",
            LANG: "pl_PL.UTF-8",
            LC_TIME: "de_DE.UTF-8",
            LC_MESSAGES: "C",
        });
    });

    it("spreads an LC_ALL onto every category but messages, since LC_ALL would override LC_MESSAGES", () => {
        const env = untranslatedEnv({ LC_ALL: "pl_PL.UTF-8", LC_CTYPE: "C" });
        expect(env["LC_ALL"]).toBeUndefined();
        expect(env["LC_MESSAGES"]).toBe("C");
        // LC_ALL overrode the caller's own LC_CTYPE, so the spread value is what git saw before too.
        expect(env["LC_CTYPE"]).toBe("pl_PL.UTF-8");
        expect(env["LC_COLLATE"]).toBe("pl_PL.UTF-8");
    });

    it("reads an empty LC_ALL as unset, as POSIX does", () => {
        expect(untranslatedEnv({ LC_ALL: "", LANG: "pl_PL.UTF-8" })).toEqual({ LANG: "pl_PL.UTF-8", LC_MESSAGES: "C" });
    });
});
