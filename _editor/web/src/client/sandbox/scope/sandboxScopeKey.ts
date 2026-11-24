import type { InjectionKey } from "vue";
import type { SandboxScope } from "./useSandboxScope";

// Its own module so a reader that only asks whether it stands in a scope (useSandboxQuery's warning) imports no scope.
export const SANDBOX_SCOPE: InjectionKey<SandboxScope> = Symbol.for(`intentic.sandbox.scope`);
