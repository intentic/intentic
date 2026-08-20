// @vitest-environment jsdom
//
// The evidence line under a filtered card. Two things are load-bearing and neither is markup: WHOSE words the
// line is (a reply quoted under a card reads as the reader's own until it says otherwise), and that the term
// is marked without ever handing chat text to v-html. Mounted with plain Vue, as ReviewStat.test does.
import { describe, expect, it } from "vitest";
import { createApp, h } from "vue";

// The marking helper lives beside the filter, which reaches the app shell and its media queries on import.

import MatchLine from "./MatchLine.vue";

const render = (props: { snippet: { text: string; speaker: `user` | `agent` }; needle?: string }): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    createApp({ render: () => h(MatchLine, props) }).mount(host);
    return host;
};

describe(`<MatchLine>`, () => {
    it(`names the side of the chat that said the line`, () => {
        expect(render({ snippet: { text: `fix the login bug`, speaker: `user` }, needle: `login` }).textContent).toBe(`You:fix the login bug`);
        expect(render({ snippet: { text: `landAgent lives in laneDrop.ts`, speaker: `agent` }, needle: `land` }).textContent).toBe(
            `Agent:landAgent lives in laneDrop.ts`,
        );
    });

    it(`marks every occurrence of the term, and nothing when none is typed`, () => {
        const marked = render({ snippet: { text: `land and land again`, speaker: `user` }, needle: `land` });
        expect(
            [...marked.querySelectorAll(`span span`)].filter((span) => span.className.includes(`bg-primary`)).map((span) => span.textContent),
        ).toEqual([`land`, `land`]);
        const plain = render({ snippet: { text: `land and land again`, speaker: `user` } });
        expect([...plain.querySelectorAll(`span span`)].filter((span) => span.className.includes(`bg-primary`))).toEqual([]);
    });

    it(`renders chat text as text — a prompt that looks like markup is not markup`, () => {
        const host = render({ snippet: { text: `<img src=x onerror=alert(1)>`, speaker: `agent` }, needle: `img` });
        expect(host.querySelector(`img`)).toBeNull();
        expect(host.textContent).toContain(`<img src=x onerror=alert(1)>`);
    });
});
