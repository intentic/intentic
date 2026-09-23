import type { StorageCategoryId, StorageCategoryUsage } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";

// What each disk category is called and why it holds what it holds, in the reader's language. Looked up when drawn,
// never built once at import, so switching language redraws them.

export interface StorageCategoryText {
    readonly label: string;
    readonly reason: string;
    // What cleaning it costs, said in the confirm before anything goes; only a category the daemon asks about has one.
    readonly warning?: string;
}

export const storageCategoryLabel = (id: StorageCategoryId): string => t(`sandbox.storageCategories.${id}.label`);

export const storageCategoryText = ({ id, cleanability }: Pick<StorageCategoryUsage, "id" | "cleanability">): StorageCategoryText => ({
    label: storageCategoryLabel(id),
    reason: t(`sandbox.storageCategories.${id}.reason`),
    ...(cleanability === `confirm` ? { warning: t(`sandbox.storageCategories.${id}.warning`) } : {}),
});
