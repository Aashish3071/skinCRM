-- Extensions required by the schema. Run as the owner role before migrations.

-- gen_random_uuid() for primary keys.
create extension if not exists "pgcrypto";

-- Exclusion constraints on tstzrange prevent double-booking a practitioner
-- (PRD CAL-03). GiST indexing of scalar columns needs btree_gist.
create extension if not exists "btree_gist";

-- Trigram indexes for staff-facing name/phone search on the leads and people lists.
create extension if not exists "pg_trgm";
