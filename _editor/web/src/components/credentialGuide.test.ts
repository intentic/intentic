// The guide panel renders whatever the catalog says, so the only thing worth pinning is that the split is
// faithful: no character of a step is lost, dropped or promoted to a literal it wasn't marked as.
import { expect, it } from "vitest";
import { guideParts } from "./credentialGuide";

it(`marks backticked runs as literals and leaves the prose alone`, () => {
    expect(guideParts("Classic: generate a token with the `repo` scope (add `write:public_key` for ssh).")).toStrictEqual([
        { text: `Classic: generate a token with the `, literal: false },
        { text: `repo`, literal: true },
        { text: ` scope (add `, literal: false },
        { text: `write:public_key`, literal: true },
        { text: ` for ssh).`, literal: false },
    ]);
});

it(`keeps a line with no markup as a single run of prose`, () => {
    expect(guideParts(`Copy the token and paste it here.`)).toStrictEqual([{ text: `Copy the token and paste it here.`, literal: false }]);
});

// A third-party extension's guide is prose we never see before it renders. An unpaired backtick must not eat
// the rest of the sentence, and it must not silently vanish either.
it(`leaves an unpaired backtick in the prose`, () => {
    expect(guideParts("Open Settings → `Developer settings.")).toStrictEqual([{ text: "Open Settings → `Developer settings.", literal: false }]);
});

it(`loses nothing when a literal opens or closes the line`, () => {
    expect(guideParts("`Socket Mode` → toggle it on")).toStrictEqual([
        { text: `Socket Mode`, literal: true },
        { text: " → toggle it on", literal: false },
    ]);
    expect(guideParts("scope `connections:write`")).toStrictEqual([
        { text: `scope `, literal: false },
        { text: `connections:write`, literal: true },
    ]);
});
