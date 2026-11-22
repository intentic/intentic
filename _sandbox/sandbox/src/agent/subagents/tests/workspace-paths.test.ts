import { workspacePaths } from "../waiting/workspace-paths.js";

test("checkout scopes accept normalized workspace-relative folder lists", () => {
    expect(workspacePaths.safeParse(["FIRMA/KADRY/Umowy", "src"])).toMatchObject({ success: true });
});

test("checkout scopes refuse empty, absolute, climbing and non-normalized paths", () => {
    for (const paths of [[], [""], ["/tmp"], ["C:/private"], ["../outside"], ["docs/../private"], ["docs//private"], ["docs\\private"]]) {
        expect(workspacePaths.safeParse(paths).success).toBe(false);
    }
    expect(workspacePaths.safeParse(Array.from({ length: 51 }, (_, index) => `folder-${index}`)).success).toBe(false);
});
