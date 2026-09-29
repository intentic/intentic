import "@intentic/testing/dom";
import { createMemoryHistory, createRouter } from "vue-router";

jest.mock("../window/capacitor.js", () => ({ inNativeShell: () => false, pushPlugin: () => undefined }));
const { installNotificationTaps } = await import("./notificationTaps");

const routerForTest = () => createRouter({
    history: createMemoryHistory(),
    routes: [{ path: `/:pathMatch(.*)*`, component: { render: () => null } }],
});

it(`routes an open app window to the notification target and acknowledges the worker`, async () => {
    const worker = new EventTarget();
    Object.defineProperty(navigator, `serviceWorker`, { configurable: true, value: worker });
    const channel = new MessageChannel();
    const acknowledged = new Promise((resolve) => {
        channel.port1.addEventListener(`message`, (event) => resolve(event.data), { once: true });
        channel.port1.start();
    });
    const router = routerForTest();
    installNotificationTaps(router);
    worker.dispatchEvent(new MessageEvent(`message`, {
        data: { type: `intentic-notification-tap`, url: `/agents/selected?need=1` },
        ports: [channel.port2],
    }));
    expect(await acknowledged).toBe(`received`);
    await router.isReady();
    expect(router.currentRoute.value.fullPath).toBe(`/agents/selected?need=1`);
});

it(`keeps a focused app on its page for root launches and routes explicit launch links`, async () => {
    let consume: ((params: { targetURL?: string }) => void) | undefined;
    Object.defineProperty(window, `launchQueue`, { configurable: true, value: { setConsumer: (fn: typeof consume) => { consume = fn; } } });
    const router = routerForTest();
    try {
        installNotificationTaps(router);
        consume?.({ targetURL: `${location.origin}/` });
        expect(router.currentRoute.value.path).toBe(`/`);
        consume?.({ targetURL: `${location.origin}/agents/picked` });
        await router.isReady();
        expect(router.currentRoute.value.path).toBe(`/agents/picked`);
    } finally {
        Reflect.deleteProperty(window, `launchQueue`);
    }
});
