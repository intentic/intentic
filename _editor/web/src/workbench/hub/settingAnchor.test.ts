import "@intentic/testing/dom";
import { seekSetting, SETTING_ATTRIBUTE } from "./settingAnchor";

// LANDING ON A CARD THAT IS NOT THERE YET. A hub page reads its settings before it draws its cards, so the card an
// answer names usually arrives after the address does: the landing has to wait for it, bring it into view and give it
// focus, and give up quietly when it never comes.

// The cards each scroll was asked for: the test DOM lays nothing out, so where a scroll goes is not this test's to
// measure, only that the one landing asked for one.
const scrolled: (string | null)[] = [];
const original = Element.prototype.scrollTo;

beforeEach(() => {
    scrolled.length = 0;
    Element.prototype.scrollTo = function (this: Element) {
        scrolled.push(document.activeElement?.getAttribute(SETTING_ATTRIBUTE) ?? null);
    };
});

afterEach(() => {
    Element.prototype.scrollTo = original;
    document.body.replaceChildren();
});

const card = (id: string): HTMLElement => {
    const element = document.createElement(`section`);
    element.setAttribute(SETTING_ATTRIBUTE, id);
    return element;
};

it(`lands on a card already drawn, and gives it focus without putting it on the tab order`, async () => {
    const theme = card(`theme`);
    document.body.append(theme);
    expect(await seekSetting(`theme`)).toBe(true);
    expect(scrolled).toEqual([`theme`]);
    expect(document.activeElement).toBe(theme);
    expect(theme.getAttribute(`tabindex`)).toBe(`-1`);
});

it(`waits for a card its page draws later`, async () => {
    const landing = seekSetting(`agent-voice`);
    const voice = card(`agent-voice`);
    setTimeout(() => document.body.append(voice), 10);
    expect(await landing).toBe(true);
    expect(scrolled).toEqual([`agent-voice`]);
});

it(`gives up at the deadline on a card that never comes`, async () => {
    expect(await seekSetting(`never-drawn`, 30)).toBe(false);
    expect(scrolled).toEqual([]);
});

it(`drops the first wait when a second answer is picked before its card came`, async () => {
    const first = seekSetting(`first`);
    const second = seekSetting(`second`);
    expect(await first).toBe(false);
    document.body.append(card(`first`), card(`second`));
    expect(await second).toBe(true);
    expect(scrolled).toEqual([`second`]);
});
