-- Email-code sign-in (api auth.ts emailOTP, sign-in.ts).

-- How many sign-in codes each address was sent in the current window, keyed by a hash of the address.
-- CreateTable
CREATE TABLE "sign_in_code_allowance" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sign_in_code_allowance_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "sign_in_code_allowance_windowStart_idx" ON "sign_in_code_allowance"("windowStart");

-- A desktop handoff for an account that signs in by email carries no Google ID token.
-- AlterTable
ALTER TABLE "desktop_handoff" ALTER COLUMN "idToken" DROP NOT NULL;
