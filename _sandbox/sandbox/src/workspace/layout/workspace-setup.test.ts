import { MIRRORED_DIRS } from "@intentic/constants/mirror-roots";
import { MANIFESTS, recipeFor } from "@intentic/workspace-setup";
import { expect, test } from "vitest";

// An isolated turn mirrors only tracked files, so a marker not in MIRRORED_DIRS reads ready with nothing installed.
// Checks every recipe's marker is mirrored and a bare directory name, so a new ecosystem is covered automatically.
test("every manifest the recipes know yields a marker that isolated turns mirror by name", () => {
    // Some manifests only signal a project alongside package.json (node); others stand alone (python); try both forms.
    const markers = [...MANIFESTS].map((manifest) => [manifest, (recipeFor([manifest]) ?? recipeFor([manifest, "package.json"]))?.marker] as const);

    expect(markers.filter(([, marker]) => marker === undefined)).toEqual([]);
    expect(markers.filter(([, marker]) => marker !== undefined && marker.includes("/"))).toEqual([]);
    expect(markers.filter(([, marker]) => marker !== undefined && !MIRRORED_DIRS.has(marker))).toEqual([]);
});
