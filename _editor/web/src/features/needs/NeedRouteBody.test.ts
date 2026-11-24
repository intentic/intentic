// A person's leave for this sandbox to act as them in another: only that person's press, from an editor signed in to
// both, mints the pairing at the target, keeps it here, and only then answers the need; anyone else reads whom it waits on.
import "@intentic/testing/dom";
import type { Need, RouteNeed } from "@intentic/sandbox-contract/schemas/needs";
import { createApp, defineComponent, h, nextTick, ref } from "vue";

const calls: string[] = [];
const answer = {
    mutateAsync: jest.fn(async (_input: { id: string; answer: { kind: string } }): Promise<void> => {
        calls.push(`answer`);
    }),
};
const sandboxJsonAt = jest.fn(async (_id: string, _path: string, _schema: unknown, _init: { body: string }) => {
    calls.push(`mint`);
    return { from: `aaaaaaaaaaaa`, person: `ada@acme.test`, secret: `s3cret-minted-over-there-0123456789abcdef`, createdAt: 1 };
});
const sandboxJson = jest.fn(async (_path: string, _init: { body: string }) => {
    calls.push(`keep`);
    return { ok: true };
});
const user = ref<{ email: string } | null>({ email: `Ada@Acme.test` });
const active = ref({ id: `sbx-here`, name: `ops` });
const sandboxes = ref([
    { id: `sbx-here`, name: `ops`, daemonUrl: `https://sandbox-aaaaaaaaaaaa.sbx.test` },
    { id: `sbx-far`, name: `app`, daemonUrl: `https://sandbox-bbbbbbbbbbbb.sbx.test` },
]);
jest.mock(`../../models/needs/useNeeds`, () => ({ useNeeds: () => ({ answer }) }));
jest.mock(`../../client/auth/useAuth`, () => ({ useAuth: () => ({ user }) }));
jest.mock(`../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ active, sandboxes }) }));
jest.mock(`../../client/sandbox/sandboxClient`, () => ({ sandboxJson, sandboxJsonAt }));
jest.mock(`./needAnswer`, () => ({
    useNeedAnswer: () => ({
        busy: ref(false),
        notice: ref(undefined),
        answer: async (options: { task: () => Promise<void> }): Promise<{ state: `done` }> => {
            await options.task();
            return { state: `done` };
        },
    }),
}));
jest.mock(`@intentic/ui`, () => ({ Notice: defineComponent({ setup: () => () => h(`div`) }) }));
jest.mock(`../../components/ChatDecisionButton.vue`, () => ({
    default: defineComponent({
        props: { disabled: Boolean },
        emits: [`click`],
        setup: (props, { slots, emit }) => () => h(`button`, { type: `button`, disabled: props.disabled, onClick: () => emit(`click`) }, slots[`default`]?.()),
    }),
}));

const { default: NeedRouteBody } = await import("./NeedRouteBody.vue");

const SUBJECT: RouteNeed = {
    kind: `route`,
    target: `bbbbbbbbbbbb`,
    targetName: `app`,
    person: `ada@acme.test`,
    scopes: [`drop`, `task`],
    address: `https://sandbox-bbbbbbbbbbbb.sbx.test`,
    from: `aaaaaaaaaaaa`,
};
const NEED: Need = { id: `need-7`, conversationId: `c-1`, title: `Let this sandbox act as ada@acme.test in app`, subject: SUBJECT, status: `open`, createdAt: 1, updatedAt: 1 };

const mount = (subject: RouteNeed = SUBJECT) => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(NeedRouteBody, { need: { ...NEED, subject }, subject }) });
    app.mount(el);
    return {
        el,
        done: (): void => {
            app.unmount();
            el.remove();
        },
    };
};

const allowButton = (el: HTMLElement) => [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `Allow`);

beforeEach(() => {
    calls.length = 0;
    answer.mutateAsync.mockClear();
    sandboxJsonAt.mockClear();
    sandboxJson.mockClear();
    user.value = { email: `Ada@Acme.test` };
});

it("mints the pairing at the target, keeps the secret here, then answers the need, on the person's one press", async () => {
    const { el, done } = mount();
    expect(el.textContent).toContain(`ada@acme.test`);
    allowButton(el)?.click();
    await nextTick();
    for (let tick = 0; tick < 4; tick += 1) {
        await Promise.resolve();
    }
    expect(sandboxJsonAt.mock.calls[0]?.[0]).toBe(`sbx-far`);
    expect(sandboxJsonAt.mock.calls[0]?.[1]).toBe(`/account/pairings`);
    expect(JSON.parse(sandboxJsonAt.mock.calls[0]?.[3].body ?? `{}`)).toEqual({ from: `aaaaaaaaaaaa`, fromName: `ops` });
    expect(sandboxJson.mock.calls[0]?.[0]).toBe(`/account/routes/secret`);
    expect(JSON.parse(sandboxJson.mock.calls[0]?.[1].body ?? `{}`)).toEqual({ target: `bbbbbbbbbbbb`, secret: `s3cret-minted-over-there-0123456789abcdef` });
    expect(answer.mutateAsync).toHaveBeenCalledWith({ id: `need-7`, answer: { kind: `approve` } });
    expect(calls).toEqual([`mint`, `keep`, `answer`]);
    done();
});

it("offers no press to anyone but the person, and says whom it waits on", () => {
    user.value = { email: `owner@acme.test` };
    const { el, done } = mount();
    expect(allowButton(el)).toBeUndefined();
    expect(el.querySelector(`[data-route-waits]`)?.textContent).toContain(`ada@acme.test`);
    done();
});

it("says so when the target is not among the reader's sandboxes here", () => {
    const { el, done } = mount({ ...SUBJECT, address: `https://sandbox-cccccccccccc.sbx.test`, targetName: `elsewhere` });
    expect(allowButton(el)).toBeUndefined();
    expect(el.querySelector(`[data-route-unreachable]`)?.textContent).toContain(`elsewhere`);
    done();
});
