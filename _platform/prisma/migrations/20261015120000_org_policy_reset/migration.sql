-- Organisations (docs/architecture/organisations.md): when a bound sandbox's daemon came back holding less of its
-- organisation's policy than it had reported, which the organisation's console shows. Null for every existing sandbox.
-- AlterTable
ALTER TABLE "sandbox" ADD COLUMN     "orgPolicyResetAt" TIMESTAMP(3);
