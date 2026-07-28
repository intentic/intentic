import { createApp, defineComponent, h, ref, shallowRef, nextTick, Teleport } from "vue";
import PrimeVue from "primevue/config";
import Tooltip from "primevue/tooltip";

const Panel = defineComponent({
    setup() {
        return () =>
            h("div", { style: "padding:40px;background:#222;color:#eee;height:100%" }, [
                h("button", { id: "hoverme", style: "margin:80px;padding:8px 16px" }, "hover me"),
            ]);
    },
});
// v-tooltip via directive on the raw button using withDirectives is fiddly in render fns; use a template app.
const App = defineComponent({
    setup() {
        const body = shallowRef<HTMLElement | undefined>();
        const popped = ref(false);
        const popOut = () => {
            const win = window.open("", "tt", "popup=1,width=700,height=500")!;
            const doc = win.document;
            if (doc.body === null) { doc.write("<!doctype html><html><head></head><body></body></html>"); doc.close(); }
            for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) doc.head.appendChild(node.cloneNode(true));
            doc.body.style.cssText = "margin:0;height:100vh;display:flex;flex-direction:column;overflow:hidden";
            body.value = doc.body;
            popped.value = true;
        };
        return { body, popped, popOut };
    },
    template: `
      <div style="height:100vh;background:#111;color:#ddd">
        <button id="pop" @click="popOut">pop out</button>
        <div style="height:400px;background:#333;margin-top:20px">MAIN AREA</div>
        <Teleport :to="popped ? body : 'body'" :disabled="!popped">
          <div id="panel" style="padding:40px;background:#222;color:#eee">
            <button id="hoverme" v-tooltip.top="'TOOLTIP TOP TEXT'" style="margin:60px;padding:8px 16px">hover me</button>
          </div>
        </Teleport>
      </div>`,
});
const app = createApp(App);
app.use(PrimeVue, { theme: { preset: undefined } });
app.directive("tooltip", Tooltip);
app.mount("#app");
