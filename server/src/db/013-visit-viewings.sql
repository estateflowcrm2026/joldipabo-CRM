-- Additive visit scheduling, event history, and per-property viewing records.
ALTER TABLE visits ADD COLUMN IF NOT EXISTS team_id text REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS created_by text REFERENCES users(id) ON DELETE SET NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='visits' AND column_name='project_id' AND is_nullable='YES'
  ) THEN
    ALTER TABLE visits ALTER COLUMN project_id DROP NOT NULL;
  END IF;
  UPDATE visits v SET team_id = u.team_id FROM users u
    WHERE v.tenant_id = u.tenant_id AND v.assigned_to = u.id AND v.team_id IS NULL;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='visits_status_check'
      AND pg_get_constraintdef(oid) LIKE '%Accepted%'
  ) THEN
    ALTER TABLE visits DROP CONSTRAINT IF EXISTS visits_status_check;
    ALTER TABLE visits ADD CONSTRAINT visits_status_check CHECK (status IN (
      'Scheduled', 'Assigned', 'Accepted', 'On the way', 'Reached',
      'Client assisted', 'Client did not attend', 'Visit cancelled',
      'Visit rescheduled', 'Completed', 'In Progress', 'Cancelled', 'No Show'
    ));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS visit_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  visit_id text NOT NULL REFERENCES visits(id) ON DELETE RESTRICT,
  actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status text NOT NULL,
  note text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS visit_viewings (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  visit_id text NOT NULL REFERENCES visits(id) ON DELETE RESTRICT,
  listing_id text NOT NULL REFERENCES listings(id) ON DELETE RESTRICT,
  agent_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  shown_at timestamptz NOT NULL,
  assistance_status text NOT NULL CHECK (assistance_status IN ('assisted', 'client_no_show', 'not_shown')),
  feedback text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS visits_tenant_id_uidx ON visits (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS listings_tenant_id_uidx ON listings (tenant_id, id);
CREATE INDEX IF NOT EXISTS visits_tenant_assignee_schedule_idx ON visits (tenant_id, assigned_to, scheduled_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS visits_tenant_lead_schedule_idx ON visits (tenant_id, lead_id, scheduled_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS visit_events_tenant_visit_idx ON visit_events (tenant_id, visit_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS visit_viewings_tenant_visit_idx ON visit_viewings (tenant_id, visit_id, shown_at DESC);
CREATE INDEX IF NOT EXISTS visit_viewings_tenant_listing_idx ON visit_viewings (tenant_id, listing_id, shown_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visit_events_tenant_visit_fk') THEN
    ALTER TABLE visit_events ADD CONSTRAINT visit_events_tenant_visit_fk FOREIGN KEY (tenant_id, visit_id) REFERENCES visits (tenant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visit_viewings_tenant_visit_fk') THEN
    ALTER TABLE visit_viewings ADD CONSTRAINT visit_viewings_tenant_visit_fk FOREIGN KEY (tenant_id, visit_id) REFERENCES visits (tenant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visit_viewings_tenant_listing_fk') THEN
    ALTER TABLE visit_viewings ADD CONSTRAINT visit_viewings_tenant_listing_fk FOREIGN KEY (tenant_id, listing_id) REFERENCES listings (tenant_id, id);
  END IF;
END $$;

ALTER TABLE visit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE visit_viewings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON visit_events;
CREATE POLICY tenant_isolation ON visit_events USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
DROP POLICY IF EXISTS tenant_isolation ON visit_viewings;
CREATE POLICY tenant_isolation ON visit_viewings USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'estateflow_app') THEN
    GRANT SELECT, INSERT, UPDATE ON visits TO estateflow_app;
    GRANT SELECT, INSERT ON visit_events, visit_viewings TO estateflow_app;
    REVOKE UPDATE, DELETE ON visit_events, visit_viewings FROM estateflow_app;
  END IF;
END $$;
