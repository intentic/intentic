import { hostSlot } from "@intentic/extension-api";
import { name, publisher } from "../intentic-extension.json";

/* The activated host handle: one slot for this extension, bound by activate(api) before anything renders and read
   through host() everywhere else. Labelled with the manifest's own id, so an early host() names the right extension. */
export const { bindHost, host } = hostSlot(`${publisher}.${name}`);
