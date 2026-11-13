import { ownerStepOf } from "./owner-steps.js";

// The line a fix agent opens its final message with when no commit fixes the failure (ci-fix.ts, OUTSIDE_THE_REPO).
test("reads the step a closing message opens with, and the rest of its paragraph", () => {
    const closing = [
        "Owner step: open item ipdmljdopicihjdlgiiplaiolngbinma in the Chrome Web Store dashboard,",
        "paste the downloads justification from STORE-LISTING.md, and Save draft.",
        "",
        "Then re-run the webstore publish workflow at v1.413.0.",
    ].join("\n");
    expect(ownerStepOf(closing)).toBe(
        "open item ipdmljdopicihjdlgiiplaiolngbinma in the Chrome Web Store dashboard, paste the downloads justification from STORE-LISTING.md, and Save draft.",
    );
});

test("finds it under markdown and further down, in any case", () => {
    expect(ownerStepOf("Summary first.\n\n**Owner step:** set the `NPM_TOKEN` secret.")).toBe("set the `NPM_TOKEN` secret.");
    expect(ownerStepOf("- owner STEP: renew the signing certificate")).toBe("renew the signing certificate");
});

test("is nothing for a closing that names no step, or an empty one", () => {
    expect(ownerStepOf("Fixed the typecheck in sandbox/src/ci.")).toBeUndefined();
    expect(ownerStepOf("Owner step:")).toBeUndefined();
    expect(ownerStepOf("")).toBeUndefined();
});

test("cuts a step that runs on past what a row can carry", () => {
    const step = ownerStepOf(`Owner step: ${"a".repeat(2_000)}`);
    expect(step?.length).toBe(600);
    expect(step?.endsWith("…")).toBe(true);
});
