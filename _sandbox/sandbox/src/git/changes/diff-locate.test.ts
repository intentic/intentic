import { DiffLocateError, parseDiffSourceQuery } from "./diff-locate.js";

/* The query string every side route accepts, read into the one typed source the locator resolves. */

const query = (pairs: Record<string, string>): URLSearchParams => new URLSearchParams(pairs);

test("each source reads into its own shape, with only the fields that source has", () => {
    expect(parseDiffSourceQuery(query({ source: "working", repo: "root", side: "unstaged", path: "a.docx", which: "before" }))).toEqual({
        source: "working",
        repo: "root",
        side: "unstaged",
        path: "a.docx",
    });
    expect(parseDiffSourceQuery(query({ source: "agent", agent: "abc", repo: "web", path: "x.pdf" }))).toEqual({
        source: "agent",
        agent: "abc",
        repo: "web",
        path: "x.pdf",
    });
    expect(parseDiffSourceQuery(query({ source: "commit", repo: "root", sha: "deadbeef", path: "x.pdf" }))).toEqual({
        source: "commit",
        repo: "root",
        sha: "deadbeef",
        path: "x.pdf",
    });
    expect(parseDiffSourceQuery(query({ source: "checkpoint", snapshot: "s1", scope: "root", path: "x.pdf" }))).toEqual({
        source: "checkpoint",
        snapshot: "s1",
        scope: "root",
        path: "x.pdf",
    });
});

test("a missing or wrong field is a 400 that names it", () => {
    expect(() => parseDiffSourceQuery(query({ source: "working", repo: "root", path: "a" }))).toThrow(DiffLocateError);
    expect(() => parseDiffSourceQuery(query({ source: "working", repo: "root", side: "sideways", path: "a" }))).toThrow(/side/);
    expect(() => parseDiffSourceQuery(query({ source: "elsewhere", path: "a" }))).toThrow(DiffLocateError);
});

// The sha is the one value that reaches git's rev-spec parser; anything but hex is refused before it gets there.
test("a commit sha that is not hex is refused, so a flag or a range can never ride it", () => {
    expect(() => parseDiffSourceQuery(query({ source: "commit", repo: "root", sha: "--output=/tmp/x", path: "a" }))).toThrow(DiffLocateError);
    expect(() => parseDiffSourceQuery(query({ source: "commit", repo: "root", sha: "HEAD..main", path: "a" }))).toThrow(DiffLocateError);
    expect(() => parseDiffSourceQuery(query({ source: "commit", repo: "root", sha: "abc", path: "a" }))).toThrow(DiffLocateError);
});
