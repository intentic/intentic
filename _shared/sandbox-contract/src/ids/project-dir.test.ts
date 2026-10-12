import { readFileSync } from "node:fs";
import { MEMORY_FILE, PUBLIC_DIR, REFERENCE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { STARTER_REPO } from "../state/starter.js";
import { isProjectDirName, projectDirCandidates, projectDirNameFor, projectDirNameOf, projectRemoteDir, RESERVED_PROJECT_DIR_NAMES } from "./project-dir.js";

// The cases `ic` is held to as well (_sandbox/ic/src/sandbox/project_dir.rs), read from the one file both run.
interface ProjectDirCases {
    readonly names: readonly { readonly name: string; readonly valid: boolean }[];
    readonly folders: readonly { readonly folder: string; readonly dirName: string }[];
}
// SAFETY: the fixture is this repository's own file, written to this shape; one that drifted fails every case below.
const CASES = JSON.parse(readFileSync(new URL("./project-dir.fixture.json", import.meta.url), "utf8")) as ProjectDirCases;

test.each([...CASES.names])("the shared name case $name is valid: $valid", ({ name, valid }) => {
    expect(isProjectDirName(name)).toBe(valid);
});

test.each([...CASES.folders])("the folder $folder syncs into $dirName", ({ folder, dirName }) => {
    expect(projectDirNameFor(folder)).toBe(dirName);
});

test("every folder name the slug produces is one the validation accepts, and slugging it again changes nothing", () => {
    for (const { folder } of CASES.folders) {
        const name = projectDirNameFor(folder);
        expect(isProjectDirName(name)).toBe(true);
        expect(projectDirNameFor(name)).toBe(name);
    }
});

test("the reserved names are the ones the daemon keeps at the workspace root", () => {
    expect([...RESERVED_PROJECT_DIR_NAMES].toSorted()).toEqual(
        [
            PUBLIC_DIR,
            REFERENCE_DIR,
            STARTER_REPO,
            MEMORY_FILE,
            "root",
            "intent",
            "desired-state",
            "app",
            "node_modules",
            "dist",
            "venv",
            "claude.json",
        ].toSorted(),
    );
});

test("a project dir is exactly one valid name under the workspace root", () => {
    expect(projectRemoteDir("my-app")).toBe(`${WORKSPACE_ROOT}/my-app`);
    expect(projectDirNameOf(`${WORKSPACE_ROOT}/my-app`)).toBe("my-app");
    expect(projectDirNameOf(WORKSPACE_ROOT)).toBeUndefined();
    expect(projectDirNameOf(`${WORKSPACE_ROOT}/`)).toBeUndefined();
    expect(projectDirNameOf(`${WORKSPACE_ROOT}/my-app/`)).toBeUndefined();
    expect(projectDirNameOf(`${WORKSPACE_ROOT}/my-app/src`)).toBeUndefined();
    expect(projectDirNameOf(`${WORKSPACE_ROOT}/public`)).toBeUndefined();
    expect(projectDirNameOf(`${WORKSPACE_ROOT}/../etc`)).toBeUndefined();
    expect(projectDirNameOf("/workspace/my-app")).toBeUndefined();
    expect(projectDirNameOf("/srv/work/my-app", "/srv/work")).toBe("my-app");
});

// A second folder of the same name takes a name that says which one it is: its parent's in front (machine_sandbox.rs
// `unique_name` takes the first one free). Where a folder is (a drive, a network share) never lends a name.
const NAMED: readonly { readonly path: string; readonly names: string[] }[] = [
    { path: "C:\\Users\\ada\\code\\app", names: ["app-project", "code-app", "ada-code-app"] },
    { path: "C:\\Users\\ada\\work\\My App", names: ["My-App", "work-My-App", "ada-work-My-App"] },
    { path: "/home/ada/sites/blog", names: ["blog", "sites-blog", "ada-sites-blog"] },
    { path: "\\\\wsl.localhost\\arch\\home\\ada\\api", names: ["api", "ada-api", "home-ada-api"] },
    { path: "\\\\server\\share\\api", names: ["api"] },
    { path: "D:\\blog", names: ["blog"] },
    { path: "D:\\", names: [] },
    { path: "C:/Users/ada/Café/menu/", names: ["menu", "Cafe-menu", "ada-Cafe-menu"] },
];
test.each([...NAMED])("$path may be called $names", ({ path, names }) => {
    const candidates = projectDirCandidates(path);
    expect(candidates).toEqual(names);
    expect(candidates.every(isProjectDirName)).toBe(true);
});
