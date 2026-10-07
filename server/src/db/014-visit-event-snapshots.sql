-- Preserve schedule and assignee at each transition, including reschedules.
ALTER TABLE visit_events ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;
ALTER TABLE visit_events ADD COLUMN IF NOT EXISTS assigned_to text REFERENCES users(id) ON DELETE SET NULL;
