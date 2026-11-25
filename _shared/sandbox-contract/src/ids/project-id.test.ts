import { normalizeProjectId } from "./project-id.js";

describe("project id", () => {
    it("reads every remote spelling of one repository as one project", () => {
        for (const remote of [
            "git@github.com:Acme/App.git",
            "https://github.com/acme/app",
            "https://user:token@github.com/acme/app.git",
            "ssh://git@github.com:22/acme/app.git",
            "github.com/acme/app/",
            "  GitHub.com/Acme/App  ",
        ]) {
            expect(normalizeProjectId(remote)).toBe("github.com/acme/app");
        }
    });

    it("keeps nested groups", () => {
        expect(normalizeProjectId("git@gitlab.com:group/sub/repo.git")).toBe("gitlab.com/group/sub/repo");
    });

    it("refuses what names no repository", () => {
        for (const text of ["", "app", "github.com", "/local/path/repo", "file:///tmp/repo", "github.com/acme app"]) {
            expect(normalizeProjectId(text)).toBeUndefined();
        }
    });

    it("drops a query, a fragment and trailing slashes as before", () => {
        expect(normalizeProjectId("https://github.com/acme/app.git//?ref=main#readme")).toBe("github.com/acme/app");
        expect(normalizeProjectId("https://github.com//acme///app///")).toBe("github.com/acme/app");
        expect(normalizeProjectId("https://github.com/acme/app#x?y")).toBe("github.com/acme/app");
        expect(normalizeProjectId("github.com/acme/.git")).toBeUndefined();
    });

    it("answers at once for a long run of `#` or `/`", () => {
        // No clock: the old patterns were quadratic on these, so a return of them runs past the test's own timeout.
        expect(normalizeProjectId(`#${"#".repeat(100_000)}`)).toBeUndefined();
        expect(normalizeProjectId(`a${"/".repeat(100_000)}b?`)).toBeUndefined();
        expect(normalizeProjectId(`github.com${"/".repeat(100_000)}acme/app${"/".repeat(100_000)}`)).toBe("github.com/acme/app");
    });
});
