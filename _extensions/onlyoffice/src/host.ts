import { hostSlot } from "@intentic/extension-api";

// This extension's own host handle, bound by activate(api) before the viewer renders.
export const { bindHost, host } = hostSlot(`ext-onlyoffice`);
