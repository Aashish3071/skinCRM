-- ---------------------------------------------------------------------------
-- Simplified pipeline (D-57). Re-applied on every migrate; idempotent.
--
-- The original eleven-stage pipeline is reduced to six:
--   New → Contacted → Booked → Visited → Won, plus Lost.
--
-- Retired stages are deactivated, never deleted: stage history references
-- them, and deleting would rewrite what actually happened to a lead. Leads
-- still sitting in a retired stage are moved to its successor, and the move is
-- written to stage history with a reason so the timeline explains it.
--
-- Keep the mapping in step with RETIRED_STAGE_CATEGORIES in
-- packages/contracts/src/enums.ts.
-- ---------------------------------------------------------------------------

do $$
declare
  mapping constant jsonb := '{
    "attempting_contact": "connected",
    "qualified": "connected",
    "nurture": "connected",
    "unqualified": "lost",
    "duplicate": "lost"
  }';
  retired record;
begin
  for retired in
    select s.id as from_id, s.clinic_id, t.id as to_id, t.is_closed as to_closed
    from pipeline_stages s
    join pipeline_stages t
      on t.clinic_id = s.clinic_id
     and t.category::text = mapping ->> s.category::text
    where mapping ? s.category::text
  loop
    insert into lead_stage_events (clinic_id, lead_id, from_stage_id, to_stage_id, actor_user_id, reason, occurred_at)
    select l.clinic_id, l.id, retired.from_id, retired.to_id, null,
           'Pipeline simplified: this stage was retired', now()
    from leads l
    where l.stage_id = retired.from_id;

    update leads
    set stage_id = retired.to_id,
        closed_at = case when retired.to_closed then coalesce(closed_at, now()) else closed_at end,
        updated_at = now()
    where stage_id = retired.from_id;

    update pipeline_stages set is_active = false, updated_at = now()
    where id = retired.from_id and is_active;
  end loop;

  -- New names and order, but only where the clinic kept the old default name:
  -- a clinic that renamed a stage chose that name on purpose.
  update pipeline_stages s
  set name = v.new_name, position = v.pos, updated_at = now()
  from (values
    ('new',                   'New',                   'New',       0),
    ('connected',             'Connected',             'Contacted', 1),
    ('consultation_booked',   'Consultation booked',   'Booked',    2),
    ('consultation_attended', 'Consultation attended', 'Visited',   3),
    ('converted',             'Converted',             'Won',       4),
    ('lost',                  'Lost',                  'Lost',      5)
  ) as v(category, old_name, new_name, pos)
  where s.category::text = v.category
    and s.name = v.old_name
    and (s.name <> v.new_name or s.position <> v.pos);
end
$$;
