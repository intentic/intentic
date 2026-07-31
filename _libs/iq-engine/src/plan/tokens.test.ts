import { expect, test } from "vitest";
import { pathTokens, queryTokens } from "./tokens.js";

test("query tokens drop stopwords and anything shorter than three characters", () => {
    // "and" used to boost `commands-and-groups.md` over the dispatcher that answers the question.
    expect(queryTokens("how are nested subcommands resolved and dispatched to their handlers?")).toEqual([
        "nested",
        "subcommands",
        "resolved",
        "dispatched",
        "their",
        "handlers",
    ]);
});

test("path tokens split on separators and camelCase humps", () => {
    expect(pathTokens("_apps/web/src/pages/workspace/viewers/FileViewer.vue")).toEqual([
        "apps",
        "web",
        "src",
        "pages",
        "workspace",
        "viewers",
        "file",
        "viewer",
        "vue",
    ]);
    expect(pathTokens("src/middleware/serve-static/index.ts")).toEqual(["src", "middleware", "serve", "static", "index", "ts"]);
    expect(pathTokens("src/click/_textwrap.py")).toEqual(["src", "click", "textwrap", "py"]);
});
