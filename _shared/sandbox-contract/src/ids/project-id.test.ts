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
});
