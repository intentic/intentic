import { effectScope, nextTick, ref } from "vue";
import { useSettled } from "@intentic/ui/async";

// One request per burst of typing: the settled value follows the field only once it has been still for the delay,
// starts out as the field already reads, and with `trim` ignores whitespace around the words entirely.
describe(`useSettled`, () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it(`starts out holding the field as it already reads, trimmed when asked`, () => {
        const scope = effectScope();
        const plain = scope.run(() => useSettled(ref(`  draft `), 150))!;
        const trimmed = scope.run(() => useSettled(ref(`  draft `), 150, { trim: true }))!;
        expect([plain.value, trimmed.value]).toEqual([`  draft `, `draft`]);
        scope.stop();
    });

    it(`follows the field only once it has been still for the delay`, async () => {
        const field = ref(``);
        const scope = effectScope();
        const settled = scope.run(() => useSettled(field, 200))!;
        field.value = `a`;
        await nextTick();
        jest.advanceTimersByTime(150);
        field.value = `ab`;
        await nextTick();
        // The second key restarted the wait: 150 ms after it is not yet 200 ms of stillness.
        jest.advanceTimersByTime(150);
        expect(settled.value).toBe(``);
        jest.advanceTimersByTime(50);
        expect(settled.value).toBe(`ab`);
        scope.stop();
    });

    it(`with trim, whitespace around the words neither restarts the wait nor changes the answer`, async () => {
        const field = ref(`cat`);
        const scope = effectScope();
        const settled = scope.run(() => useSettled(field, 100, { trim: true }))!;
        field.value = `cats`;
        await nextTick();
        jest.advanceTimersByTime(60);
        field.value = `cats `;
        await nextTick();
        // Had the space restarted the clock, 40 ms more would not be enough.
        jest.advanceTimersByTime(40);
        expect(settled.value).toBe(`cats`);
        scope.stop();
    });

    it(`never settles after its surface is gone`, async () => {
        const field = ref(``);
        const scope = effectScope();
        const settled = scope.run(() => useSettled(field, 100))!;
        field.value = `late`;
        await nextTick();
        scope.stop();
        jest.advanceTimersByTime(500);
        expect(settled.value).toBe(``);
    });
});
