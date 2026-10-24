import type { OrgDetail } from "@intentic/api-contract";
import { ref, nextTick } from "vue";
import { inSetup } from "../../testing/inSetup";
import { useOrgPolicyDraft } from "./useOrgPolicyDraft";

const detail = (policyVersion: number, policy: OrgDetail[`policy`] = { sections: {} }): OrgDetail => ({
    id: `office`, name: `Journey office`, role: `admin`, policyVersion, policy,
});
const stops: (() => void)[] = [];
const stage = (initial = detail(1)) => {
    const org = ref(initial);
    const { result: draft, stop } = inSetup(() => useOrgPolicyDraft(() => org.value));
    stops.push(stop);
    return { org, draft };
};
afterEach(() => stops.splice(0).forEach((stop) => stop()));

it(`follows a newer policy returned by a membership change while the controls are clean`, async () => {
    const { org, draft } = stage();
    org.value = detail(2, { sections: { secrets: `hidden` }, membersOnly: true });
    await nextTick();
    expect(draft.draft.value.find((row) => row.section === `secrets`)?.mode).toBe(`hidden`);
    expect(draft.membersOnly.value).toBe(true);
    expect(draft.rules.value).toEqual({ sections: { secrets: `hidden` }, membersOnly: true });
    expect(draft.expectedVersion.value).toBe(2);
    expect(draft.dirty.value).toBe(false);
});

it(`keeps unsaved controls tied to their original edition after a member or sandbox response`, async () => {
    const { org, draft } = stage();
    const models = draft.draft.value.find((row) => row.section === `models`);
    if (models === undefined) { throw new Error(`missing Models control`); }
    models.mode = `locked`;
    org.value = detail(2, { sections: { secrets: `hidden` } });
    await nextTick();
    expect(draft.rules.value).toEqual({ sections: { models: `locked` } });
    expect(draft.expectedVersion.value).toBe(1);
    expect(draft.dirty.value).toBe(true);
});

it(`keeps an unsaved required setting tied to the edition it came from`, async () => {
    const { org, draft } = stage();
    const pin = draft.pins.value[0];
    if (pin === undefined) { throw new Error(`missing preset group`); }
    pin.pinned = true;
    draft.membersOnly.value = true;
    org.value = detail(2, { sections: { secrets: `hidden` } });
    await nextTick();
    expect(draft.rules.value).toEqual({ sections: {}, preset: [pin.group], membersOnly: true });
    expect(draft.expectedVersion.value).toBe(1);
    expect(draft.dirty.value).toBe(true);
});

it(`accepts a successful save as the next draft's base`, async () => {
    const { org, draft } = stage();
    draft.membersOnly.value = true;
    const saved = detail(2, { sections: {}, membersOnly: true });
    draft.accept(saved);
    org.value = saved;
    await nextTick();
    expect(draft.rules.value).toEqual({ sections: {}, membersOnly: true });
    expect(draft.expectedVersion.value).toBe(2);
    expect(draft.dirty.value).toBe(false);
    draft.membersOnly.value = false;
    expect(draft.rules.value).toEqual({ sections: {} });
    expect(draft.dirty.value).toBe(true);
});
