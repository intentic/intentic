import { describe, expect, test } from "vitest";
import { intentPackageJson, libsLinkSpec } from "./intent-repo.js";

describe("intentPackageJson", () => {
    test("writes the caller-supplied specs verbatim as the two @intentic deps", () => {
        const pkg = JSON.parse(intentPackageJson("~1.2.3", "~1.2.3")) as { dependencies: Record<string, string> };
        expect(pkg.dependencies).toEqual({ "@intentic/graph": "~1.2.3", "@intentic/sdk": "~1.2.3" });
    });

    test("carries link specs through unchanged (dev/link mode)", () => {
        const pkg = JSON.parse(
            intentPackageJson("link:/opt/sandbox/node_modules/@intentic/graph", "link:/opt/sandbox/node_modules/@intentic/sdk"),
        ) as {
            dependencies: Record<string, string>;
        };
        expect(pkg.dependencies["@intentic/graph"]).toBe("link:/opt/sandbox/node_modules/@intentic/graph");
        expect(pkg.dependencies["@intentic/sdk"]).toBe("link:/opt/sandbox/node_modules/@intentic/sdk");
    });
});

describe("libsLinkSpec", () => {
    test("points a link: at this monorepo's _libs/<pkg>", () => {
        expect(libsLinkSpec("graph")).toMatch(/^link:.*[/\\]_libs[/\\]graph$/);
        expect(libsLinkSpec("sdk")).toMatch(/^link:.*[/\\]_libs[/\\]sdk$/);
    });
});
