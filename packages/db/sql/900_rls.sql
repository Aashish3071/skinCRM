-- ---------------------------------------------------------------------------
-- Row-level security. Re-runnable: applied after every migration.
--
-- Model: the application connects as `skincrm_app`, which owns nothing and is
-- not a superuser, so policies apply to it. Each request opens a transaction
-- and calls `set_config('app.clinic_id', <uuid>, true)`. Policies compare
-- `clinic_id` to that setting.
--
-- Fail-closed by construction: with the setting unset, `nullif(...)` yields
-- NULL, the comparison is NULL, and the row is filtered out. A forgotten WHERE
-- clause therefore returns nothing instead of another clinic's data.
--
-- `force row level security` is essential. Without it the table OWNER bypasses
-- policies, which would silently disable isolation if the app ever connected as
-- the owner role.
-- ---------------------------------------------------------------------------

-- Current tenant, or NULL when unscoped.
create or replace function app_current_clinic_id() returns uuid
language sql stable
as $$
  select nullif(current_setting('app.clinic_id', true), '')::uuid
$$;

-- Current actor, or NULL for unauthenticated work such as webhook ingestion.
create or replace function app_current_user_id() returns uuid
language sql stable
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

do $$
declare
  tbl text;
  -- Every tenant-scoped table with a `clinic_id` column.
  tenant_tables text[] := array[
    'branches',
    'users',
    'user_branches',
    'sessions',
    'auth_tokens',
    'mfa_recovery_codes',
    'pipeline_stages',
    'audit_events',
    -- Phase 2: core CRM
    'people',
    'general_notes',
    'consent_records',
    'person_merges',
    'source_submissions',
    'raw_payloads',
    'leads',
    'lead_stage_events',
    'activities',
    'tasks',
    'assignment_rules',
    -- Phase 3: calendar
    'consultation_types',
    'working_hours',
    'appointments'
  ];
begin
  foreach tbl in array tenant_tables loop
    if to_regclass('public.' || quote_ident(tbl)) is null then
      raise notice 'skipping %, table not present yet', tbl;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', tbl);
    execute format('alter table public.%I force row level security', tbl);
    execute format('drop policy if exists %I on public.%I', tbl || '_tenant_isolation', tbl);
    execute format(
      'create policy %I on public.%I
         using (clinic_id = app_current_clinic_id())
         with check (clinic_id = app_current_clinic_id())',
      tbl || '_tenant_isolation', tbl
    );
  end loop;
end
$$;

-- The clinics table is keyed by `id`, not `clinic_id`.
alter table public.clinics enable row level security;
alter table public.clinics force row level security;
drop policy if exists clinics_tenant_isolation on public.clinics;
create policy clinics_tenant_isolation on public.clinics
  using (id = app_current_clinic_id())
  with check (id = app_current_clinic_id());

-- ---------------------------------------------------------------------------
-- Privileges for the application role.
-- ---------------------------------------------------------------------------

grant usage on schema public to skincrm_app;
grant select, insert, update, delete on all tables in schema public to skincrm_app;
grant usage, select on all sequences in schema public to skincrm_app;

-- Future tables created by migrations inherit these grants.
alter default privileges in schema public
  grant select, insert, update, delete on tables to skincrm_app;
alter default privileges in schema public
  grant usage, select on sequences to skincrm_app;

-- The audit trail is append-only (PRD AUD-01). Even a fully compromised
-- application process cannot rewrite or erase history.
revoke update, delete on public.audit_events from skincrm_app;

-- Clinic provisioning is an operator action, not an API call. The app may read
-- and update its own clinic row but never create or delete one.
revoke insert, delete on public.clinics from skincrm_app;
