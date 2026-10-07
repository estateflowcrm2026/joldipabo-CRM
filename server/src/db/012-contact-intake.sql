-- Contact intake before lead qualification. Applied after 011; never edit prior migrations.
CREATE TABLE IF NOT EXISTS contacts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  name text NOT NULL,
  phone text NOT NULL,
  alternate_phone text,
  email text,
  requirements text,
  notes text,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  team_id text REFERENCES teams(id) ON DELETE SET NULL,
  project_id text REFERENCES projects(id) ON DELETE SET NULL,
  lead_id text REFERENCES leads(id) ON DELETE SET NULL,
  created_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS contact_calls (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  contact_id text NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  agent_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  occurred_at timestamptz NOT NULL,
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  outcome text NOT NULL CHECK (outcome IN ('interested', 'follow_up', 'not_interested', 'no_answer', 'other')),
  notes text,
  next_follow_up timestamptz,
  provider text,
  provider_call_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contacts_tenant_owner_idx ON contacts (tenant_id, owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS contacts_tenant_phone_idx ON contacts (tenant_id, phone);
CREATE INDEX IF NOT EXISTS contact_calls_tenant_contact_idx ON contact_calls (tenant_id, contact_id, occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_tenant_lead_uidx ON contacts (tenant_id, lead_id) WHERE lead_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contact_calls_provider_uidx ON contact_calls (tenant_id, provider, provider_call_id) WHERE provider IS NOT NULL AND provider_call_id IS NOT NULL;
-- These composite targets also make cross-tenant references fail at the database layer.
CREATE UNIQUE INDEX IF NOT EXISTS leads_tenant_id_uidx ON leads (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_tenant_id_uidx ON contacts (tenant_id, id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_tenant_lead_fk') THEN
    ALTER TABLE contacts ADD CONSTRAINT contacts_tenant_lead_fk FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_calls_tenant_contact_fk') THEN
    ALTER TABLE contact_calls ADD CONSTRAINT contact_calls_tenant_contact_fk FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id);
  END IF;
END $$;

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_calls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON contacts;
CREATE POLICY tenant_isolation ON contacts USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
DROP POLICY IF EXISTS tenant_isolation ON contact_calls;
CREATE POLICY tenant_isolation ON contact_calls USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'estateflow_app') THEN
    GRANT SELECT, INSERT, UPDATE ON contacts TO estateflow_app;
    GRANT SELECT, INSERT ON contact_calls TO estateflow_app;
    REVOKE DELETE ON contacts FROM estateflow_app;
    REVOKE UPDATE, DELETE ON contact_calls FROM estateflow_app;
  END IF;
END $$;
