import { asSession } from "./repair";

// The Repair session as the app sends it (src-tauri/src/repair/mod.rs, serialized camelCase), read into the shape the
// view draws (the web's local/repair/LocalRepair.vue): the state's own word, every message, and while the daily allowance
// is spent, when it resets, which the view says in the reader's own time.

it(`carries when a spent allowance resets, so the view can say it`, () => {
    const spent = asSession({ state: `idle`, messages: [{ id: `m1`, role: `user`, text: `Why is my sandbox down?` }], allowanceResetsAt: `2026-10-13T00:00:00Z` });
    expect(spent).toEqual({
        state: `idle`,
        messages: [{ id: `m1`, role: `user`, text: `Why is my sandbox down?`, tool: undefined }],
        allowanceResetsAt: `2026-10-13T00:00:00Z`,
    });
});

it(`says nothing about the allowance while there is some left, and reads a tool waiting for Allow as waiting`, () => {
    const session = asSession({
        state: `waitingApproval`,
        messages: [{ id: `m2`, role: `tool`, text: ``, tool: { name: `fix`, state: `needsApproval`, summary: `Fix shop`, approvalId: `a1` } }],
    });
    expect([session.state, `allowanceResetsAt` in session, session.messages[0]?.tool?.approvalId]).toEqual([`waiting`, false, `a1`]);
});
