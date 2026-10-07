import { STATE_DIR } from "@intentic/constants";
import { isDeriveIgnored } from "./derive.js";

describe("the derive floor (what never gets a shadow, whoever asks)", () => {
    test("machine subtrees, state, the reference shelf and agent worktrees are refused", () => {
        for (const path of [
            "node_modules/pkg/manual.pdf",
            `${STATE_DIR}/local/cache/derived/x.docx`,
            "refs/other-repo/spec.docx",
            ".claude/worktrees/fix/docs/a.pdf",
        ]) {
            expect(isDeriveIgnored(path), path).toBe(true);
        }
    });

    test("ordinary workspace documents are not", () => {
        for (const path of ["docs/spec.docx", "repo/assets/logo.png", "a repo/refs/inner.pdf"]) {
            expect(isDeriveIgnored(path), path).toBe(false);
        }
    });
});
