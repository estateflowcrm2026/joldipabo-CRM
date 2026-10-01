-- Joldipabo CRM — Demo seed.
--
-- Mirrors the frontend's src/data/seed.js shape so the demo backend
-- can be queried the same way the frontend is today.
--
-- This file is illustrative only. The scaffold does not run it
-- automatically (no DB connection wired yet). To load it manually:
--   psql "$DATABASE_URL" -f src/db/schema.sql -f src/db/indexes.sql -f src/db/seed-demo.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
INSERT INTO organisations (id, slug, name, status) VALUES
    ('org_acme', 'acme', 'Acme Developers', 'Active');

INSERT INTO branches (id, tenant_id, name, region) VALUES
    ('br_bangalore', 'org_acme', 'Bangalore', 'South India');

-- ---------------------------------------------------------------------------
-- Roles (mirrors src/data/permissions.js ROLE_DEFINITIONS)
-- ---------------------------------------------------------------------------
INSERT INTO roles (id, name, description, color, accent, is_system) VALUES
    ('super-admin',              'Super Admin',              'Org owner. Unrestricted access.',                       '#0F1A1F', '#C49B4A', true),
    ('admin',                    'Admin',                    'Configures teams, projects, and staff.',                '#1F3A36', '#3F7B6F', true),
    ('sales-manager',            'Sales Manager',            'Owns a sales team.',                                    '#3D2E1F', '#C49B4A', false),
    ('site-manager',             'Site Manager',             'Owns site operations.',                                 '#2A3D2F', '#5E8C5A', false),
    ('field-executive',          'Field Executive',          'Field sales. Self check-in, logs visits.',              '#2E3447', '#6F7BB3', false),
    ('telecaller',               'Telecaller',               'Phone-based lead qualification.',                       '#3F2D45', '#9D6FA3', false),
    ('channel-partner-manager',  'Channel Partner Manager',  'Manages external broker network.',                      '#1F3D3A', '#3F8C84', false),
    ('accounts',                 'Accounts',                 'Read-only on pipeline, full access to bookings.',       '#3D3A1F', '#B0A14A', false);

-- Permission matrices — copy of src/data/permissions.js DEFAULT_PERMISSION_MATRIX,
-- stored as JSONB. Kept short here for readability; the real seed is the file above.

-- ---------------------------------------------------------------------------
-- Teams
-- ---------------------------------------------------------------------------
INSERT INTO teams (id, tenant_id, name, region, lead_id) VALUES
    ('t_north',  'org_acme', 'North Sales',  'North Bangalore', 'u-raj'),
    ('t_south',  'org_acme', 'South Sales',  'South Bangalore', NULL);

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------
INSERT INTO projects (id, tenant_id, name, code, city, stage, total_units, available_units, manager_id, type) VALUES
    ('p_skyline', 'org_acme', 'Skyline Heights',  'SKY', 'Bangalore', 'Booking open', 120, 42, 'u-priya', 'Residential'),
    ('p_heights', 'org_acme', 'Acme Heights',     'HTS', 'Bangalore', 'Pre-launch',   80, 80, 'u-priya', 'Luxury Residential');

-- ---------------------------------------------------------------------------
-- Users (mirrors src/data/seed.js USERS)
-- ---------------------------------------------------------------------------
INSERT INTO users (id, tenant_id, branch_id, name, email, phone, role_id, team_id, designation, status, joined_at) VALUES
    ('u-admin',   'org_acme', 'br_bangalore', 'Demo Admin',     'admin@acme.example',    '+910000000001', 'admin',         NULL,      'Operations Manager',  'Active', '2024-01-15'),
    ('u-super',   'org_acme', 'br_bangalore', 'Demo Super',     'super@acme.example',    '+910000000002', 'super-admin',    NULL,      'Org Owner',           'Active', '2024-01-01'),
    ('u-raj',     'org_acme', 'br_bangalore', 'Raj Mehta',      'raj@acme.example',      '+919876500001', 'sales-manager',  't_north', 'Sales Manager',       'Active', '2024-02-10'),
    ('u-priya',   'org_acme', 'br_bangalore', 'Priya Sharma',   'priya@acme.example',    '+919876500002', 'site-manager',   NULL,      'Site Manager',        'Active', '2024-02-12'),
    ('u-asha',    'org_acme', 'br_bangalore', 'Asha Rao',       'asha@acme.example',     '+919876500003', 'field-executive','t_north', 'Field Executive',     'Active', '2024-03-01'),
    ('u-vijay',   'org_acme', 'br_bangalore', 'Vijay Kumar',    'vijay@acme.example',    '+919876500004', 'field-executive','t_south', 'Field Executive',     'Active', '2024-03-08'),
    ('u-anil',    'org_acme', 'br_bangalore', 'Anil Verma',     'anil@acme.example',     '+919876500005', 'accounts',       NULL,      'Accounts',            'Active', '2024-03-15'),
    ('u-tele',    'org_acme', 'br_bangalore', 'Tara Iyer',      'tara@acme.example',     '+919876500006', 'telecaller',     't_north', 'Telecaller',          'Active', '2024-03-20'),
    ('u-cpm',     'org_acme', 'br_bangalore', 'Partner Lead',   'cpm@acme.example',      '+919876500007', 'channel-partner-manager', NULL, 'Partner Manager', 'Active', '2024-04-01');

INSERT INTO user_project_ids (user_id, project_id) VALUES
    ('u-priya', 'p_skyline'),
    ('u-priya', 'p_heights'),
    ('u-asha',  'p_skyline'),
    ('u-raj',   'p_skyline'),
    ('u-raj',   'p_heights'),
    ('u-anil',  'p_skyline');

INSERT INTO project_members (project_id, user_id) VALUES
    ('p_skyline', 'u-priya'),
    ('p_heights', 'u-priya'),
    ('p_skyline', 'u-asha'),
    ('p_heights', 'u-raj'),
    ('p_skyline', 'u-raj'),
    ('p_skyline', 'u-anil');

-- ---------------------------------------------------------------------------
-- Listings — cross-vertical property catalogue.
-- One row per vertical to demonstrate the matrix. Real seed data
-- grows organically as field executives collect more properties.
-- ---------------------------------------------------------------------------
INSERT INTO listings (
    id, tenant_id, service_category, property_type, listing_intent,
    title, description, address, city, locality, geo,
    price, rent_monthly, deposit, area_sqft, bedrooms, bathrooms, furnished,
    amenities, availability_status, verification_status,
    owner_contact_name, owner_contact_phone,
    assigned_to, team_id, project_id,
    created_by
) VALUES
    ('l_rent_indiranagar_3bhk',
     'org_acme', 'rent', 'apartment', 'available_for_rent',
     '3BHK in Indiranagar with covered parking',
     'Semi-furnished 3BHK on the 4th floor of a quiet lane. Walking distance to 100ft Road.',
     '14, 5th Cross, Indiranagar', 'Bangalore', 'Indiranagar',
     '{"lat": 12.9719, "lng": 77.6412, "accuracy": 8}',
     NULL, 65000, 200000, 1450, 3, 2, 'semi',
     '["Covered parking","24x7 water","Power backup","Lift"]'::jsonb,
     'available', 'verified',
     'Mr. Bhattacharya', '+919900000111',
     'u-asha', 't_north', NULL,
     'u-asha'),

    ('l_pg_koramangala_bed',
     'org_acme', 'pg', 'pg_bed', 'available_for_rent',
     'Single bed in Koramangala ladies PG',
     'Single-occupancy bed in a 4-sharing room. AC, attached bath, meals included.',
     '8, 1st Main, Koramangala 5th Block', 'Bangalore', 'Koramangala',
     '{"lat": 12.9352, "lng": 77.6245, "accuracy": 12}',
     NULL, 14500, 29000, NULL, 1, 1, 'fully',
     '["Meals included","Wi-Fi","Laundry","CCTV"]'::jsonb,
     'available', 'pending',
     'Ms. Reddy', '+919900000222',
     'u-asha', 't_north', NULL,
     'u-asha'),

    ('l_land_devanahalli_plot',
     'org_acme', 'land', 'land_parcel', 'available_for_sale',
     '1.2 acre NA plot near Devanahalli',
     'Clear-title NA converted plot, 200m from the upcoming PRR exit. Ideal for villa project.',
     'Sy No. 47, Devanahalli', 'Bangalore', 'Devanahalli',
     '{"lat": 13.2506, "lng": 77.7094, "accuracy": 20}',
     45000000, NULL, NULL, 52272, NULL, NULL, NULL,
     '["NA converted","Clear title","Road access","Bore well"]'::jsonb,
     'available', 'verified',
     'Mr. Shetty', '+919900000333',
     'u-vijay', 't_south', NULL,
     'u-vijay'),

    ('l_office_whitefield_3000sqft',
     'org_acme', 'office', 'office', 'available_for_rent',
     'Ready-to-move office, Whitefield',
     'Fully fitted 3000 sq ft office with 12 cabins, 1 conference room, 1 server room.',
     'Tower B, RMZ Infinity, Whitefield', 'Bangalore', 'Whitefield',
     '{"lat": 12.9698, "lng": 77.7500, "accuracy": 10}',
     NULL, 175000, 700000, 3000, NULL, 4, 'fully',
     '["Fitted cabins","Conference room","Server room","Pantry","24x7 access"]'::jsonb,
     'available', 'verified',
     'RMZ Leasing', '+919900000444',
     'u-asha', 't_north', NULL,
     'u-asha'),

    ('l_buy_indep_house_jayanagar',
     'org_acme', 'buy', 'independent_house', 'wanted',
     'Looking for 4BHK independent house in Jayanagar / JP Nagar',
     'Buyer relocating from Singapore. Needs ready-to-move, 2500+ sq ft, east-facing.',
     NULL, 'Bangalore', 'Jayanagar',
     NULL,
     75000000, NULL, NULL, 2800, 4, 4, 'fully',
     '["Garden","Servant quarter","4 car parking"]'::jsonb,
     'available', 'unverified',
     'Mr. Iyer (Buyer)', '+919900000555',
     'u-tele', 't_north', NULL,
     'u-tele'),

    -- Owner-listed resale: a 3BHK in a residential society, owner selling
    -- directly (no project anchor, no team anchor), captured by Tara
    -- (telecaller, t_north) and verified by the site team.
    ('l_sell_resale_3bhk_hsr',
     'org_acme', 'sell', 'apartment', 'available_for_sale',
     'Owner-resale 3BHK in HSR Layout Sector 2',
     'Direct from owner. 3BHK on the 6th floor, semi-furnished, registered Khata, clear title.',
     '27, 14th Cross, HSR Layout Sector 2', 'Bangalore', 'HSR Layout',
     '{"lat": 12.9116, "lng": 77.6473, "accuracy": 9}',
     18500000, NULL, NULL, 1620, 3, 2, 'semi',
     '["Gym","Swimming pool","Children play area","2 car parking","24x7 security"]'::jsonb,
     'available', 'verified',
     'Mr. Kulkarni', '+919900000666',
     'u-tele', 't_north', NULL,
     'u-tele');

-- ---------------------------------------------------------------------------
-- Leads (sample) — extends the legacy new-sale shape with the new
-- cross-vertical fields. Keep this block small; the frontend seed in
-- src/data/seed.js remains the canonical reference.
-- ---------------------------------------------------------------------------
INSERT INTO leads (
    id, tenant_id, name, phone, email,
    service_need, client_type, requirements,
    budget_min, budget_max, rent_min, rent_max,
    preferred_location, desired_property_type,
    move_in_date, purchase_timeline,
    status, score, source, notes,
    owner_id, team_id, created_by
) VALUES
    ('ld_tenant_meera',
     'org_acme', 'Meera Krishnan', '+919811110001', 'meera@example.com',
     'rent', 'tenant', '{"furnished": "semi", "pets": "friendly", "parking": 1}'::jsonb,
     NULL, NULL, 45000, 75000,
     'Indiranagar | Koramangala', 'apartment',
     '2026-10-15', NULL,
     'Site Visit Scheduled', 'hot', 'Walk-in', 'Wants east-facing. Has a small dog.',
     'u-asha', 't_north', 'u-asha'),

    ('ld_buyer_sandeep',
     'org_acme', 'Sandeep Reddy', '+919811110002', 'sandeep@example.com',
     'buy', 'buyer', '{"bedrooms": 4, "car_parking": 2, "floor": "high"}'::jsonb,
     60000000, 80000000, NULL, NULL,
     'Jayanagar | JP Nagar', 'independent_house',
     NULL, 'within_3_months',
     'Negotiation', 'hot', 'Referral', 'NRIs, agreement signing this month.',
     'u-vijay', 't_south', 'u-vijay'),

    ('ld_land_seller_rajesh',
     'org_acme', 'Rajesh Gowda', '+919811110003', 'rajesh.land@example.com',
     'sell', 'landlord', '{"area_min_sqft": 40000, "zoning": "NA", "title_clear": true}'::jsonb,
     38000000, 48000000, NULL, NULL,
     'Devanahalli', 'land_parcel',
     NULL, 'immediate',
     'New', 'warm', 'Direct', 'Looking for quick closure; banker referred.',
     'u-vijay', 't_south', 'u-vijay'),

    ('ld_pg_seeker_anu',
     'org_acme', 'Anu Pillai', '+919811110004', 'anu@example.com',
     'pg', 'tenant', '{"gender": "female", "occupancy": "single", "meals": true}'::jsonb,
     NULL, NULL, 12000, 18000,
     'Koramangala | BTM', 'pg_bed',
     '2026-09-01', NULL,
     'Follow-up', 'warm', 'Meta Ads', 'Working professional. Visits this weekend.',
     'u-asha', 't_north', 'u-tele');

-- Seed two listing_matches to exercise the cross-suggest flow.
INSERT INTO listing_matches (id, tenant_id, lead_id, listing_id, match_score, status, matched_by) VALUES
    ('lm_001', 'org_acme', 'ld_tenant_meera',  'l_rent_indiranagar_3bhk',     92.50, 'viewed_by_lead', 'u-asha'),
    ('lm_002', 'org_acme', 'ld_pg_seeker_anu', 'l_pg_koramangala_bed',       88.00, 'suggested',     NULL),
    ('lm_003', 'org_acme', 'ld_land_seller_rajesh', 'l_land_devanahalli_plot', 75.00, 'suggested',  'u-vijay');

COMMIT;

-- ---------------------------------------------------------------------------
-- Notes for future seeds
-- ---------------------------------------------------------------------------
-- * Lead, visit, attendance, photo, thread, message seeds are deliberately
--   omitted here; they are large and should be loaded from src/data/seed.js
--   converted to SQL by an offline script.
-- * permission_matrices rows must be added per role — keep this file in
--   sync with src/data/permissions.js DEFAULT_PERMISSION_MATRIX.
