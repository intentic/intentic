import "@intentic/testing/dom";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { type EffectScope, effectScope, nextTick, ref } from "vue";
import type { TerminalSession } from "../terminalsQuery";
import { useTerminalHelp } from "./useTerminalHelp";

// Pins the handover ask: the active tab shows its own session's ask, a reply carries the trimmed note only when there
// is one and answers once however often it is pressed, and switching tabs drops a half-typed note.

const scopes: EffectScope[] = [];
const listed = (name: string, help?: TerminalSession[`help`]): TerminalSession => ({
    name,
    kind: `agent`,
    running: true,
    activityAt: 0,
    ...(help === undefined ? {} : { help }),
});

const stage = () => {
    const sessions = ref<TerminalSession[]>([listed(`a`, { requestId: `r1`, message: `Enter the 2FA code`, requestedAt: 1_000 }), listed(`b`)]);
    const activeName = ref<string | undefined>(`a`);
    const reply = mock(async (_answer: unknown) => true);
    const scope = effectScope();
    scopes.push(scope);
    const help = scope.run(() => useTerminalHelp({ sessions, activeName, reply }))!;
    return { activeName, reply, help };
};

afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
});

describe(`the handover ask`, () => {
    it(`shows the ask of the active tab's own session`, async () => {
        const { activeName, help } = stage();
        expect(help.help.value?.message).toBe(`Enter the 2FA code`);
        activeName.value = `b`;
        await nextTick();
        expect(help.help.value).toBe(undefined);
    });

    it(`answers once, with the trimmed note when there is one`, async () => {
        const { reply, help } = stage();
        help.helpNote.value = `  done, typed it  `;
        const first = help.resolveHelp(true);
        await help.resolveHelp(true);
        await first;
        await help.resolveHelp(false);
        expect(reply.mock.calls).toEqual([
            [{ kind: `terminal_help`, requestId: `r1`, helped: true, note: `done, typed it` }],
            [{ kind: `terminal_help`, requestId: `r1`, helped: false }],
        ]);
        expect(help.helpNote.value).toBe(``);
    });

    it(`drops a half-typed note when the tab changes`, async () => {
        const { activeName, help } = stage();
        help.helpNote.value = `almost`;
        activeName.value = `b`;
        await nextTick();
        expect(help.helpNote.value).toBe(``);
    });
});
