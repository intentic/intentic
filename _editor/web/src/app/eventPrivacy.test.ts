import "@intentic/testing/dom";
import { registerCatalog } from "@intentic/ui/i18n";
import type { CaptureResult } from "posthog-js";
import { addressRedactor, eventPrivacy } from "./eventPrivacy";

// The interface's own wording, as a real catalog registers it.
await registerCatalog({ namespace: `eventprobe`, base: { commit: `Commit all` }, load: () => Promise.reject(new Error(`unused`)) });

// What the router answers for the paths these cases use; routePattern.test.ts holds the real matching.
const patternOf = (path: string): string | undefined => {
    if (path.startsWith(`/workspace`)) {
        return `/workspace/:path*`;
    }
    return path.startsWith(`/agents/`) ? `/agents/:id` : undefined;
};
const redact = addressRedactor(patternOf, () => `app.intentic.dev`);
const send = eventPrivacy(redact);

// What a masked value must look like: every character that is not a space replaced by a star.
const blank = (value: string): string => value.replace(/\S/g, `*`);

const event = (name: string, properties: CaptureResult["properties"], rest: Partial<CaptureResult> = {}): CaptureResult => ({
    uuid: `01a0ed26`,
    event: name,
    properties,
    ...rest,
});

describe(`addresses`, () => {
    it(`becomes the route pattern for a URL or a path of this app, with no query and no hash`, () => {
        expect(redact(`https://app.intentic.dev/workspace/web/src/checkout.ts?line=4#L2`)).toBe(`https://app.intentic.dev/workspace/:path*`);
        expect(redact(`/workspace/web/src/checkout.ts?line=4`)).toBe(`/workspace/:path*`);
        expect(redact(`/agents/cnv_checkout_stripe#top`)).toBe(`/agents/:id`);
    });

    it(`falls back to the first segment when no route matches, or the router throws`, () => {
        expect(redact(`/secret-area/plan.md`)).toBe(`/secret-area`);
        expect(redact(`https://app.intentic.dev/secret-area/plan.md`)).toBe(`https://app.intentic.dev/secret-area`);
        const broken = addressRedactor(() => {
            throw new Error(`no router yet`);
        });
        expect(broken(`/workspace/a.ts`)).toBe(`/workspace`);
    });

    it(`cuts another site's address to its origin`, () => {
        expect(redact(`https://www.google.com/search?q=intentic+secret`)).toBe(`https://www.google.com/`);
    });

    it(`returns what is not an address as it came, and a URL that does not parse as a blank page`, () => {
        expect(redact(`$direct`)).toBe(`$direct`);
        expect(redact(`app.intentic.dev`)).toBe(`app.intentic.dev`);
        expect(redact(`https://`)).toBe(`about:blank`);
    });
});

describe(`a page event`, () => {
    it(`carries the route in every property that held an address, and no title`, () => {
        const sent = send(
            event(`$pageview`, {
                $current_url: `https://app.intentic.dev/workspace/web/src/checkout.ts?line=4`,
                $pathname: `/workspace/web/src/checkout.ts`,
                $prev_pageview_pathname: `/agents/cnv_checkout_stripe`,
                $session_entry_url: `https://app.intentic.dev/agents/cnv_checkout_stripe`,
                $session_entry_pathname: `/agents/cnv_checkout_stripe`,
                $referrer: `$direct`,
                $host: `app.intentic.dev`,
                title: `checkout.ts / intentic`,
                client: `browser`,
            }),
        );
        expect(sent?.properties).toEqual({
            $current_url: `https://app.intentic.dev/workspace/:path*`,
            $pathname: `/workspace/:path*`,
            $prev_pageview_pathname: `/agents/:id`,
            $session_entry_url: `https://app.intentic.dev/agents/:id`,
            $session_entry_pathname: `/agents/:id`,
            $referrer: `$direct`,
            $host: `app.intentic.dev`,
            title: blank(`checkout.ts / intentic`),
            client: `browser`,
        });
    });

    // The first event a person sends also sets who they are and where they came in.
    it(`does the same for what it sets on the person`, () => {
        const sent = send(
            event(
                `$pageview`,
                { $current_url: `https://app.intentic.dev/workspace/a.ts` },
                {
                    $set: { $current_url: `https://app.intentic.dev/workspace/a.ts`, $pathname: `/workspace/a.ts`, email: `a@b.c` },
                    $set_once: {
                        $initial_current_url: `https://app.intentic.dev/agents/cnv_1`,
                        $initial_pathname: `/agents/cnv_1`,
                        $initial_referrer: `https://www.google.com/search?q=secret`,
                    },
                },
            ),
        );
        expect(sent?.$set).toEqual({ $current_url: `https://app.intentic.dev/workspace/:path*`, $pathname: `/workspace/:path*`, email: `a@b.c` });
        expect(sent?.$set_once).toEqual({
            $initial_current_url: `https://app.intentic.dev/agents/:id`,
            $initial_pathname: `/agents/:id`,
            $initial_referrer: `https://www.google.com/`,
        });
    });

    it(`leaves the event it was given alone`, () => {
        const original = event(`$pageview`, { $pathname: `/workspace/a.ts` });
        send(original);
        expect(original.properties).toEqual({ $pathname: `/workspace/a.ts` });
    });
});

describe(`a click event`, () => {
    // What the SDK builds: `$el_text` and `$elements` for the clicked element and its parents, and the same again as one
    // string. Kept: the interface's own wording and structure. Gone: the name of a file, a path, an id built from one.
    const clicked = (): CaptureResult =>
        event(`$autocapture`, {
            $current_url: `https://app.intentic.dev/workspace/src/lib/checkout.ts`,
            $el_text: `src/lib/checkout.ts`,
            $elements: [
                {
                    tag_name: `button`,
                    $el_text: `src/lib/checkout.ts`,
                    classes: [`row`, `flex`],
                    "attr__aria-label": `Stage: src/lib/checkout.ts`,
                    attr__title: `Commit all`,
                    attr__href: `/workspace/src/lib/checkout.ts`,
                    attr__id: `row_4f9`,
                    attr__class: `row flex`,
                    nth_child: 2,
                    nth_of_type: 1,
                },
                { tag_name: `div`, attr__id: `app`, nth_child: 1, nth_of_type: 1 },
            ],
            $elements_chain:
                `button.flex.row:attr__aria-label="Stage: src/lib/checkout.ts"attr__class="row flex"attr__href="/workspace/src/lib/checkout.ts"` +
                `attr__id="row_4f9"attr__title="Commit all"nth-child="2"nth-of-type="1"text="src/lib/checkout.ts";` +
                `div:attr__id="app"attr_id="app"nth-child="1"nth-of-type="1"`,
        });

    it(`masks the text and attributes of the elements, and keeps the interface's own`, () => {
        const sent = send(clicked());
        expect(sent?.properties[`$el_text`]).toBe(blank(`src/lib/checkout.ts`));
        expect(sent?.properties[`$elements`]).toEqual([
            {
                tag_name: `button`,
                $el_text: blank(`src/lib/checkout.ts`),
                classes: [`row`, `flex`],
                "attr__aria-label": blank(`Stage: src/lib/checkout.ts`),
                attr__title: `Commit all`,
                attr__href: blank(`/workspace/src/lib/checkout.ts`),
                attr__id: blank(`row_4f9`),
                attr__class: `row flex`,
                nth_child: 2,
                nth_of_type: 1,
            },
            { tag_name: `div`, attr__id: `app`, nth_child: 1, nth_of_type: 1 },
        ]);
    });

    it(`masks the same fields inside the chain the SDK builds from them`, () => {
        expect(send(clicked())?.properties[`$elements_chain`]).toBe(
            `button.flex.row:attr__aria-label="${blank(`Stage: src/lib/checkout.ts`)}"attr__class="row flex"attr__href="${blank(`/workspace/src/lib/checkout.ts`)}"` +
                `attr__id="${blank(`row_4f9`)}"attr__title="Commit all"nth-child="2"nth-of-type="1"text="${blank(`src/lib/checkout.ts`)}";` +
                `div:attr__id="app"attr_id="app"nth-child="1"nth-of-type="1"`,
        );
    });

    // The SDK escapes a quote in a value as `\"`; a value that reads as our words must come back escaped the same way.
    it(`unescapes a quoted value before comparing it and escapes it again`, async () => {
        await registerCatalog({ namespace: `eventquote`, base: { hint: `Say "hi"` }, load: () => Promise.reject(new Error(`unused`)) });
        const chain = `button:attr__title="Say \\"hi\\""text="Say \\"bye\\""nth-child="1"`;
        expect(send(event(`$autocapture`, { $elements_chain: chain }))?.properties[`$elements_chain`]).toBe(
            `button:attr__title="Say \\"hi\\""text="${blank(`Say "bye"`)}"nth-child="1"`,
        );
    });

    it(`treats a rage click and a dead click the same way, since they carry the same fields`, () => {
        const sent = send(event(`$rageclick`, { $el_text: `README.md`, $current_url: `https://app.intentic.dev/workspace/README.md` }));
        expect(sent?.properties).toEqual({ $el_text: blank(`README.md`), $current_url: `https://app.intentic.dev/workspace/:path*` });
    });
});

describe(`other events`, () => {
    it(`keys a heatmap by route, so pages that share one keep each other's points`, () => {
        const sent = send(
            event(`$$heatmap`, {
                $heatmap_data: {
                    "https://app.intentic.dev/workspace/a.ts": [{ x: 1 }],
                    "https://app.intentic.dev/workspace/b.ts": [{ x: 2 }],
                    "https://app.intentic.dev/agents/cnv_1": [{ x: 3 }],
                },
            }),
        );
        expect(sent?.properties[`$heatmap_data`]).toEqual({
            "https://app.intentic.dev/workspace/:path*": [{ x: 1 }, { x: 2 }],
            "https://app.intentic.dev/agents/:id": [{ x: 3 }],
        });
    });

    it(`masks the message of an exception and leaves the stack, whose frames are the app's own bundle`, () => {
        const frames = [{ filename: `https://app.intentic.dev/assets/index-1a2b.js`, function: `load`, lineno: 12 }];
        const sent = send(
            event(`$exception`, {
                $current_url: `https://app.intentic.dev/workspace/src/a.ts`,
                $exception_list: [{ type: `Error`, value: `ENOENT: no such file src/a.ts`, stacktrace: { type: `raw`, frames } }],
                $exception_types: [`Error`],
                $exception_values: [`ENOENT: no such file src/a.ts`],
            }),
        );
        const message = `ENOENT: no such file src/a.ts`;
        expect(sent?.properties).toEqual({
            $current_url: `https://app.intentic.dev/workspace/:path*`,
            $exception_list: [{ type: `Error`, value: blank(message), stacktrace: { type: `raw`, frames } }],
            $exception_types: [`Error`],
            $exception_values: [blank(message)],
        });
    });

    it(`passes a replay snapshot through untouched, and a missing event as it is`, () => {
        const snapshot = event(`$snapshot`, { $current_url: `https://app.intentic.dev/workspace/a.ts`, $snapshot_data: [] });
        expect(send(snapshot)).toBe(snapshot);
        expect(send(null)).toBeNull();
    });

    it(`leaves our own milestone events as they are`, () => {
        const sent = send(event(`message_sent`, { agent: `claude`, queued: false }));
        expect(sent?.properties).toEqual({ agent: `claude`, queued: false });
    });
});
