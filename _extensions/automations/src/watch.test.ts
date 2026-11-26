import { extensionIdOf } from "@intentic/extension-manifest";
import { BUILT_IN_WATCH_KINDS } from "@intentic/sandbox-contract/schemas/automations";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { messages } from "./i18n";
import { manifest } from "./manifest";
import { sourceLabel } from "./watch";

await registerExtensionMessages(extensionIdOf(manifest), messages);

// A watch's source on its row, in the words of the kind's own declaration (2026-11-26): no kind is named here.

test(`a contributed kind reads as its declaration's sentence, and one nothing here declares as its id and parameters`, () => {
    expect(sourceLabel({ kind: `npm`, package: `bun`, range: `>=1.4.3` }, BUILT_IN_WATCH_KINDS)).toBe(`npm bun@>=1.4.3`);
    expect(sourceLabel({ kind: `github-release`, repo: `oven-sh/bun`, prereleases: true }, BUILT_IN_WATCH_KINDS)).toBe(`GitHub releases of oven-sh/bun (prereleases too)`);
    expect(sourceLabel({ kind: `github-release`, repo: `oven-sh/bun` }, BUILT_IN_WATCH_KINDS)).toBe(`GitHub releases of oven-sh/bun`);
    expect(sourceLabel({ kind: `pypi`, package: `httpx`, pre: true }, BUILT_IN_WATCH_KINDS)).toBe(`pypi package=httpx pre`);
});

test(`a page reads as its address, with the pattern it watches when it has one`, () => {
    expect(sourceLabel({ kind: `url`, url: `https://example.com/status` }, [])).toBe(`https://example.com/status`);
    expect(sourceLabel({ kind: `url`, url: `https://example.com/status`, select: `v(\\d+)` }, [])).toBe(`https://example.com/status, matching v(\\d+)`);
});
