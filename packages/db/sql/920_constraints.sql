-- ---------------------------------------------------------------------------
-- Constraints Drizzle cannot express. Re-runnable: applied after every
-- migration, like the RLS script.
-- ---------------------------------------------------------------------------

-- Prevent double-booking a member of staff (PRD CAL-03).
--
-- An exclusion constraint, not an application check. Two receptionists booking
-- the same slot in the same second would both read it as free, and the second
-- write would succeed. Postgres serializes this for us: the second INSERT is
-- refused outright.
--
-- Cancelled and rescheduled rows are excluded from the constraint, because the
-- slot they used to hold is genuinely free again — without the WHERE clause a
-- cancelled appointment would block its own replacement.
--
-- Needs btree_gist for the uuid equality operator inside a GiST index; the
-- extension is installed in 010_extensions.sql.
do $$
begin
  if to_regclass('public.appointments') is null then
    raise notice 'appointments table not present yet, skipping overlap constraint';
    return;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'appointments_no_staff_overlap'
  ) then
    alter table public.appointments
      add constraint appointments_no_staff_overlap
      exclude using gist (
        staff_user_id with =,
        tstzrange(starts_at, ends_at) with &&
      )
      where (status not in ('canceled', 'rescheduled'));
  end if;
end
$$;

-- An appointment must end after it starts. Cheap, and it catches a timezone or
-- duration bug at the point of insert rather than as a strange empty calendar.
do $$
begin
  if to_regclass('public.appointments') is null then
    return;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'appointments_end_after_start'
  ) then
    alter table public.appointments
      add constraint appointments_end_after_start check (ends_at > starts_at);
  end if;
end
$$;

-- Working hours must describe a real window on a real day.
do $$
begin
  if to_regclass('public.working_hours') is null then
    return;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'working_hours_valid_day') then
    alter table public.working_hours
      add constraint working_hours_valid_day check (day_of_week between 0 and 6);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'working_hours_end_after_start') then
    alter table public.working_hours
      add constraint working_hours_end_after_start check (end_time > start_time);
  end if;
end
$$;

-- A consultation cannot last a negative amount of time.
do $$
begin
  if to_regclass('public.consultation_types') is null then
    return;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'consultation_types_positive_duration') then
    alter table public.consultation_types
      add constraint consultation_types_positive_duration
      check (duration_minutes > 0 and buffer_minutes >= 0);
  end if;
end
$$;
