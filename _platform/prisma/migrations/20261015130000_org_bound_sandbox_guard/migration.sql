-- Organisations (docs/architecture/organisations.md): a sandbox an organisation holds is never deleted while it is
-- held, by any path. The api refuses a delete and an account erasure itself, under the row lock a bind takes; this is the
-- database's own word for what no route can reach, such as the cascade when an account row is deleted after its erase
-- committed. Releasing the sandbox (orgId set to null, as deleting the organisation also does) lifts it.
CREATE FUNCTION "sandbox_org_bound_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD."orgId" IS NOT NULL THEN
        -- The default SQLSTATE (P0001), not a foreign-key one: the client then reports this sentence rather than a
        -- constraint it would have to name.
        RAISE EXCEPTION 'sandbox % belongs to an organisation; an admin of it must release the sandbox before it can be deleted', OLD."id";
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER "sandbox_org_bound_guard" BEFORE DELETE ON "sandbox"
    FOR EACH ROW EXECUTE FUNCTION "sandbox_org_bound_guard"();
