import type { BrowserPage } from "@intentic/sandbox-contract/schemas/terminal";
import { nextTick, ref } from "vue";
import { inSetup } from "../../testing/inSetup";
import { useNavigationLine } from "./pageProgress";

// What the address bar says while the page waits, where a browser's own would: a click that sent the page to a host that
// never answered must not look like a click that did nothing.

const page = (extra: Partial<BrowserPage> = {}): BrowserPage => ({ id: `p1`, url: `http://192.168.0.103:9120/login`, active: true, ...extra });

describe(`the address bar's waiting line`, () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(100_000);
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    test(`names the host the navigation waits on, then how long once it has outlasted a blip`, async () => {
        const shown = ref<BrowserPage | undefined>(page({ loading: true, navigation: { url: `http://192.168.0.168/oauth/authorize?x=1`, since: 99_000 } }));
        const { result: line, stop } = inSetup(() => useNavigationLine(shown));
        expect(line.value).toBe(`Waiting for 192.168.0.168…`);
        shown.value = page({ loading: true, navigation: { url: `http://192.168.0.168/oauth/authorize?x=1`, since: 88_000 } });
        jest.advanceTimersByTime(1_000);
        await nextTick();
        expect(line.value).toBe(`Waiting for 192.168.0.168… · 13s`);
        stop();
    });

    test(`is gone once the navigation arrives, fails or stops`, async () => {
        const shown = ref<BrowserPage | undefined>(page({ loading: true, navigation: { url: `http://192.168.0.168/`, since: 99_000 } }));
        const { result: line, stop } = inSetup(() => useNavigationLine(shown));
        shown.value = page();
        await nextTick();
        expect(line.value).toBeUndefined();
        stop();
    });
});
