import { displayNameOf, isFileWorkCall, isRootListing, isSearchCall, searchPrecedesFileWork, toolCategoryOf, toolPathsUnder, toolTarget } from "./tool-calls.js";

// The agent's root in these fixtures; the predicates only compare paths against it, nothing here touches the disk.
const CWD = "/repo";

test("displayNameOf maps OpenCode's lowercase ids and passes Claude names through", () => {
    expect(displayNameOf("bash")).toBe("Bash");
    expect(displayNameOf("patch")).toBe("Edit");
    expect(displayNameOf("list")).toBe("LS");
    expect(displayNameOf("Edit")).toBe("Edit");
    expect(displayNameOf("mystery")).toBe("mystery");
});

test("toolCategoryOf categorizes builtin names case-insensitively", () => {
    expect(toolCategoryOf("Read")).toBe("read");
    expect(toolCategoryOf("Edit")).toBe("edit");
    expect(toolCategoryOf("Write")).toBe("edit");
    expect(toolCategoryOf("Bash")).toBe("execute");
    expect(toolCategoryOf("Grep")).toBe("search");
    expect(toolCategoryOf("WebFetch")).toBe("fetch");
    expect(toolCategoryOf("websearch")).toBe("search");
    expect(toolCategoryOf("Task")).toBe("other");
    expect(toolCategoryOf("mystery")).toBe("other");
});

// Category alone can't answer whether a call searched: this workspace's search tool is a CLI (`iq q ...`), which
// categorizes as `execute`.
test("isSearchCall counts the CLI searches the category misses, and leaves shell plumbing alone", () => {
    expect(isSearchCall({ category: "search", target: "createServer" })).toBe(true);
    expect(isSearchCall({ category: "execute", target: `iq q "where is the floor enforced"` })).toBe(true);
    // Past a `cd`, and past a path: the statement that matters is rarely the first word of the command.
    expect(isSearchCall({ category: "execute", target: `cd /work/intentic && iq def createIgnoreScope` })).toBe(true);
    expect(isSearchCall({ category: "execute", target: `/usr/bin/rg -n "TODO" src` })).toBe(true);
    expect(isSearchCall({ category: "execute", target: `RG_FLAGS=x grep -rn needle .` })).toBe(true);
    // A command that greps its OWN output is shell plumbing, not the model looking for code.
    expect(isSearchCall({ category: "execute", target: `git log --oneline | grep fix` })).toBe(false);
    expect(isSearchCall({ category: "execute", target: `pnpm test` })).toBe(false);
    // A tool with no command to read: a browser click is `execute` too.
    expect(isSearchCall({ category: "execute" })).toBe(false);
    expect(isSearchCall({ category: "read", target: "src/index.ts" })).toBe(false);
});

// The line is depth: a listing of the root or one level down is orientation; three levels down is looking at something
// already chosen.
test("isRootListing counts the orientation listings and leaves the ones that are work alone", () => {
    expect(isRootListing({ category: "execute", target: "ls" }, CWD)).toBe(true);
    expect(isRootListing({ category: "execute", target: "ls -la" }, CWD)).toBe(true);
    expect(isRootListing({ category: "execute", target: `ls ${CWD}` }, CWD)).toBe(true);
    expect(isRootListing({ category: "execute", target: `ls ${CWD}/intentic` }, CWD)).toBe(true);
    expect(isRootListing({ category: "execute", target: "tree intentic/" }, CWD)).toBe(true);
    // A filter behind a pipe belongs to the filter, not to the listing.
    expect(isRootListing({ category: "execute", target: "ls | head -30" }, CWD)).toBe(true);
    // A compound command is read statement by statement, like every predicate here.
    expect(isRootListing({ category: "execute", target: `cd ${CWD} && ls docs` }, CWD)).toBe(true);

    expect(isRootListing({ category: "execute", target: `ls ${CWD}/intentic/_sandbox/sandbox/src` }, CWD)).toBe(false);
    expect(isRootListing({ category: "execute", target: "ls src/agent" }, CWD)).toBe(false);
    // A glob is a question about files, which no map answers.
    expect(isRootListing({ category: "execute", target: "ls intentic/*.json" }, CWD)).toBe(false);
    // Outside the workspace entirely: a listing of somewhere the map never described.
    expect(isRootListing({ category: "execute", target: "ls /etc" }, CWD)).toBe(false);
    expect(isRootListing({ category: "execute", target: "rg needle" }, CWD)).toBe(false);
    // The native listing tool, whose target is a path rather than a command line.
    expect(isRootListing({ name: "LS", category: "search", target: CWD }, CWD)).toBe(true);
    expect(isRootListing({ name: "LS", category: "search" }, CWD)).toBe(true);
    expect(isRootListing({ name: "LS", category: "search", target: `${CWD}/a/b/c` }, CWD)).toBe(false);
    expect(isRootListing({ name: "Grep", category: "search", target: "needle" }, CWD)).toBe(false);
});

test("isFileWorkCall recognizes direct shell reads but not output-truncation pipes", () => {
    expect(isFileWorkCall({ category: "read", target: "src/index.ts" })).toBe(true);
    expect(isFileWorkCall({ category: "edit", target: "src/index.ts" })).toBe(true);
    expect(isFileWorkCall({ category: "execute", target: "sed -n '1,80p' src/index.ts" })).toBe(true);
    expect(isFileWorkCall({ category: "execute", target: "cd repo && /usr/bin/cat src/index.ts" })).toBe(true);
    expect(isFileWorkCall({ category: "execute", target: "rg needle src | head -20" })).toBe(false);
    expect(isFileWorkCall({ category: "execute", target: "git log | sed -n '1,20p'" })).toBe(false);
    // A compound call can both search and reach a file; callers must not make the classifications exclusive.
    const compound = { category: "execute" as const, target: "rg needle src; sed -n '1,80p' src/index.ts" };
    expect(isSearchCall(compound)).toBe(true);
    expect(isFileWorkCall(compound)).toBe(true);
    expect(searchPrecedesFileWork(compound)).toBe(true);
    expect(searchPrecedesFileWork({ category: "execute", target: "cat src/index.ts; rg needle src" })).toBe(false);
});

test("toolCategoryOf categorizes MCP names by their tool segment's trailing verb", () => {
    expect(toolCategoryOf("mcp__hashline__hashline_edit")).toBe("edit");
    expect(toolCategoryOf("mcp__docs__page_read")).toBe("read");
    expect(toolCategoryOf("obs.search")).toBe("search");
    expect(toolCategoryOf("mcp__voice__join_call")).toBe("other");
});

test("browser tools read as going somewhere, doing something, or looking at the result", () => {
    expect(displayNameOf("mcp__web__browser_navigate")).toBe("Browser navigate");
    expect(displayNameOf("mcp__reddit__browser_click")).toBe("Browser click");
    expect(displayNameOf("mcp__web__browser_take_screenshot")).toBe("Browser screenshot");
    expect(displayNameOf("mcp__web__browser_navigate_back")).toBe("Browser navigate back");

    expect(toolCategoryOf("mcp__web__browser_navigate")).toBe("fetch");
    expect(toolCategoryOf("mcp__web__browser_snapshot")).toBe("read");
    expect(toolCategoryOf("mcp__web__browser_take_screenshot")).toBe("read");
    expect(toolCategoryOf("mcp__reddit__browser_click")).toBe("execute");
    // Unlisted verbs are acts on the page, not unknowns.
    expect(toolCategoryOf("mcp__web__browser_fill_form")).toBe("execute");
});

test("toolTarget picks the most specific key across both spelling families", () => {
    expect(toolTarget({ file_path: "/repo/a.ts" })).toBe("/repo/a.ts");
    expect(toolTarget({ filePath: "/repo/a.ts" })).toBe("/repo/a.ts");
    expect(toolTarget({ command: "ls -la" })).toBe("ls -la");
    expect(toolTarget({ pattern: "TODO" })).toBe("TODO");
    expect(toolTarget({ url: "https://x.dev" })).toBe("https://x.dev");
    // What a browser click/type is aimed at, in @playwright/mcp's own words: its `ref` ("e12") says nothing.
    expect(toolTarget({ element: "Submit button", ref: "e12" })).toBe("Submit button");
    expect(toolTarget({ query: "how" })).toBe("how");
    expect(toolTarget({ file_path: "/repo/a.ts", command: "ignored" })).toBe("/repo/a.ts");
    expect(toolTarget("nope")).toBeUndefined();
    expect(toolTarget({})).toBeUndefined();
});

test("toolPathsUnder names a file inside the root, relative to it, and nothing outside", () => {
    expect(toolPathsUnder({ file_path: "/repo/src/a.ts" }, CWD)).toEqual([{ path: "src/a.ts" }]);
    expect(toolPathsUnder({ notebook_path: "notes/run.ipynb" }, CWD)).toEqual([{ path: "notes/run.ipynb" }]);
    expect(toolPathsUnder({ file_path: "/etc/hosts" }, CWD)).toBeUndefined();
    expect(toolPathsUnder({ path: "/repo" }, CWD)).toBeUndefined();
    expect(toolPathsUnder({ command: "ls" }, CWD)).toBeUndefined();
});
