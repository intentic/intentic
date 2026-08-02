import type { Icon } from "@intentic/ui";

// <Icon> is registered globally in installUi (see @intentic/ui plugin). Teach Volar about it so
// `<Icon name="…">` is type-checked against IconName across every template without a per-file import.
declare module "vue" {
    export interface GlobalComponents {
        Icon: typeof Icon;
    }
}
