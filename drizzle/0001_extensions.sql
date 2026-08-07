-- Extensions and prerequisites.
-- TECHNICAL_DESIGN §5.7. Must run before the generated schema migration.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- NOTE: uuid_generate_v7() is deliberately NOT used. pg_uuidv7 is not a standard
-- Supabase extension, so UUIDv7 is generated in application code instead
-- (src/platform/crypto/newId). Ids therefore arrive with every INSERT.
