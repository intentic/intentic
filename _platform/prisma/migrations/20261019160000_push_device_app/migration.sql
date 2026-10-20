-- The native Android editor app (dev.intentic.app) registers with the push relay beside the Intentic Device app, and
-- the two want different messages from FCM: the Device app is woken, the editor is told what to fetch and show. `app`
-- says which holds the token; every existing Android row is the Device app, which is the default, and an iOS row is
-- the editor's iPhone app. `sandbox` is the sandbox an editor registration named, handed back in each notify so the
-- app knows which daemon to ask. It joins the unique key, so one token holds one row (and one secret) per sandbox;
-- every existing row named none, so the old (userId, token) pairs stay unique under the new key.

-- DropIndex
DROP INDEX "push_device_userId_token_key";

-- AlterTable
ALTER TABLE "push_device" ADD COLUMN "app" TEXT NOT NULL DEFAULT 'device',
ADD COLUMN "sandbox" TEXT NOT NULL DEFAULT '';

-- An iOS row was always the editor; read only for Android, but stored true.
UPDATE "push_device" SET "app" = 'editor' WHERE "platform" <> 'android';

-- CreateIndex
CREATE UNIQUE INDEX "push_device_userId_token_sandbox_key" ON "push_device"("userId", "token", "sandbox");
