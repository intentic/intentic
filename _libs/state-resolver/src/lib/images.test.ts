import { expect, test } from "vitest";

import { IMAGES } from "./images.js";

// Every THIRD-PARTY pin must be fully immutable: a registry/repo, an explicit tag (never `latest`), AND a sha256
// digest. This guards the strict-locking invariant — a loosely-tagged or digest-less entry fails here, so an
// accidental `:latest` or major-only pin can never land. The first-party `sandbox` is the deliberate exception:
// it tracks the moving `stable` release tag (see images.ts), so it is asserted separately below.
const STRICT = /^[a-z0-9.\-/:]+:[A-Za-z0-9][\w.-]*@sha256:[a-f0-9]{64}$/;

test("every third-party image is pinned to a full tag + sha256 digest", () => {
    for (const [name, ref] of Object.entries(IMAGES)) {
        if (name === "sandbox") continue;
        expect(ref, `${name} must match repo:tag@sha256:<digest>`).toMatch(STRICT);
        expect(ref, `${name} must not use a floating :latest tag`).not.toContain(":latest");
    }
});

// The first-party sandbox is intentionally unpinned — it must track the moving `stable` release tag (only the
// release moves it, onto a published version), never a digest pin and never `:latest` (the 0.0.0 continuous build).
test("the first-party sandbox tracks the moving stable release tag", () => {
    expect(IMAGES.sandbox).toBe("registry.gitlab.com/radarsu/intentic/sandbox:stable");
});
