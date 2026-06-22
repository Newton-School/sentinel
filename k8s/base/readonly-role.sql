-- SELECT-only Postgres role for the read-only dashboard.
--
-- Run ONCE against the ParadeDB `sentinel` database AFTER the bot's first boot
-- (its migrations create the tables), as the superuser `sentinel`:
--
--   kubectl -n sentinel-staging exec -i sentinel-paradedb-0 -- \
--     psql -U sentinel -d sentinel < k8s/base/readonly-role.sql
--
-- Then point the dashboard's DATABASE_URL_READONLY (in sentinel-dashboard-secrets)
-- at this role:
--   postgres://sentinel_ro:<PASSWORD>@sentinel-paradedb:5432/sentinel
--
-- Idempotent: safe to re-run after later migrations add tables.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_ro') THEN
    -- Replace the password to match the dashboard secret's DATABASE_URL_READONLY.
    CREATE ROLE sentinel_ro LOGIN PASSWORD 'REPLACE_ME';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE sentinel TO sentinel_ro;
GRANT USAGE ON SCHEMA public TO sentinel_ro;

-- Read existing tables…
GRANT SELECT ON ALL TABLES IN SCHEMA public TO sentinel_ro;

-- …and any tables the bot's migrations create later (granted by role sentinel).
ALTER DEFAULT PRIVILEGES FOR ROLE sentinel IN SCHEMA public
  GRANT SELECT ON TABLES TO sentinel_ro;
