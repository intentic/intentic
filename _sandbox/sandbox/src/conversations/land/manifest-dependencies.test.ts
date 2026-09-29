import { addedNames, declaredDependencies, isManifest } from "./manifest-dependencies.js";

// What a manifest declares, by name: the reading the review's "adds dependencies" line compares across the anchor.

const names = (path: string, text: string): string[] | undefined => {
    const declared = declaredDependencies(path, text);
    return declared === undefined ? undefined : [...declared.keys()];
};

test("a manifest is known by its file name at any depth, and nothing that merely resembles one", () => {
    expect(["package.json", "video/package.json", "pyproject.toml", "api/requirements.txt", "requirements-dev.txt"].map(isManifest)).toEqual([
        true,
        true,
        true,
        true,
        true,
    ]);
    expect(["mypackage.json", "package.json.bak", "package-lock.json", "docs/requirements.md", "pyproject.toml.orig"].map(isManifest)).toEqual([
        false,
        false,
        false,
        false,
        false,
    ]);
});

test("package.json declares the names of every block an install reads, and nothing else", () => {
    const text = JSON.stringify({
        name: "app",
        scripts: { build: "tsc" },
        dependencies: { hono: "^4" },
        devDependencies: { vitest: "^4" },
        optionalDependencies: { sharp: "^0.33" },
        peerDependencies: { react: "*" },
        bundledDependencies: ["left-out"],
    });
    expect(names("package.json", text)).toEqual(["hono", "vitest", "sharp", "react"]);
});

test("a manifest that cannot be read as one says nothing, rather than that it declares nothing", () => {
    expect(names("package.json", "{ not json")).toBeUndefined();
    expect(names("package.json", "[]")).toBeUndefined();
    expect(names("pyproject.toml", "[project\ndependencies = [")).toBeUndefined();
    // Readable, with no [project] table: a manifest that declares nothing, which is an answer.
    expect(names("pyproject.toml", '[tool.ruff]\nline-length = 100\n')).toEqual([]);
});

test("Python names compare the way pip does, and keep the spelling the manifest wrote", () => {
    const before = declaredDependencies("requirements.txt", "Flask_Login==0.6\n")!;
    const after = declaredDependencies("requirements.txt", "flask-login==0.7\n--hash=sha256:abc\n./vendored\nZope.Interface>=6\n")!;
    expect(addedNames(before, after)).toEqual(["Zope.Interface"]);
});
