import { nextTick, ref } from "vue";
import { onSubagentActivity } from "./subagentActivity";

// The roster's push moving a working child's stamp re-reads its transcript; a finished one, or one off screen, waits.
test("a working child's moved stamp reads again, once per move, and only while it works and is seen", async () => {
    const activityAt = ref(1);
    const live = ref(true);
    const visible = ref(true);
    let reads = 0;
    const stop = onSubagentActivity(
        () => activityAt.value,
        () => live.value,
        () => visible.value,
        () => {
            reads += 1;
        },
    );
    activityAt.value = 2;
    await nextTick();
    expect(reads).toBe(1);

    visible.value = false;
    activityAt.value = 3;
    await nextTick();
    expect(reads).toBe(1);

    visible.value = true;
    live.value = false;
    activityAt.value = 4;
    await nextTick();
    expect(reads).toBe(1);
    stop();
});
