-- Hand-written fixture rows for local dev and tests. Plain INSERTs: a second
-- run fails on the primary keys instead of overwriting real data.
INSERT INTO import_runs (id, source, file_url, released_at, fetched_at, row_count) VALUES
  (1, 'bmf', 'https://www.irs.gov/pub/irs-soi/eo_dc.csv', '2026-09-08T12:00:00.000Z', '2026-09-10T03:00:00.000Z', 5),
  (2, 'pub78', 'https://apps.irs.gov/pub/epostcard/data-download-pub78.zip', '2026-09-01T12:00:00.000Z', '2026-09-10T03:05:00.000Z', 3),
  (3, 'revocation', 'https://apps.irs.gov/pub/epostcard/data-download-revocation.zip', '2026-09-02T12:00:00.000Z', '2026-09-10T03:06:00.000Z', 1),
  (4, 'epostcard', 'https://apps.irs.gov/pub/epostcard/data-download-epostcard.zip', '2026-09-03T12:00:00.000Z', '2026-09-10T03:07:00.000Z', 1),
  (5, 'efile_index', 'https://apps.irs.gov/pub/epostcard/990/xml/2026/index_2026.csv', '2026-09-04T12:00:00.000Z', '2026-09-10T03:10:00.000Z', 3);

INSERT INTO orgs (
  ein, name, street, city, state, zip, subsection, ntee, ruling_date,
  deductibility_code, filing_requirement_code, bmf_run_id,
  deductible, pub78_run_id, revoked, revocation_date, revocation_run_id,
  files_990n, epostcard_website, epostcard_run_id
) VALUES
  -- fully populated 501(c)(3), 990 filer
  ('530196605', 'AMERICAN NATIONAL RED CROSS', '431 18TH ST NW', 'WASHINGTON', 'DC', '20006-5310', '03', 'P20', '1946-06',
   '1', '01', 1, 1, 2, 0, NULL, 3, 0, NULL, NULL),
  -- 990-N (e-Postcard) filer
  ('271234567', 'SUNNYSIDE YOUTH SOCCER LEAGUE', '120 FIELD RD', 'BOISE', 'ID', '83702', '03', 'N64', '2011-03',
   '1', '06', 1, 1, 2, 0, NULL, 3, 1, 'sunnysidesoccer.example', 4),
  -- private foundation, 990-PF filer
  ('136009999', 'HALVERSEN FAMILY FOUNDATION', '50 PARK AVE', 'NEW YORK', 'NY', '10016-3005', '03', 'T20', '1958-11',
   '1', '01', 1, 1, 2, 0, NULL, 3, 0, NULL, NULL),
  -- revoked for failing to file three years running
  ('201234567', 'LAPSED COMMUNITY THEATER INC', '9 MAIN ST', 'DAYTON', 'OH', '45402', '03', 'A65', '2004-08',
   '1', '01', 1, 0, 2, 1, '2023-05-15', 3, 0, NULL, NULL),
  -- 501(c)(4), not deductible, 990-EZ filer
  ('521234567', 'GREATER RIVERTON CIVIC LEAGUE', '300 ELM ST', 'RIVERTON', 'WY', '82501', '04', 'S20', '1979-02',
   '2', '01', 1, 0, 2, 0, NULL, 3, 0, NULL, NULL);

INSERT INTO filings (
  ein, object_id, return_id, form_type, tax_period, tax_year, mission,
  activity_summary, website, total_revenue, total_expenses, total_assets_eoy, run_id
) VALUES
  ('530196605', '202511319349301234', '31234567', '990', '2025-06', 2024,
   'The American Red Cross prevents and alleviates human suffering in the face of emergencies by mobilizing the power of volunteers and the generosity of donors.',
   'Disaster relief, biomedical services, training and services to the armed forces.',
   'https://www.redcross.org', 3215000000, 3108000000, 4021000000, 5),
  ('136009999', '202501239349100500', '30500500', '990-PF', '2024-12', 2024,
   NULL, NULL, 'https://halversenfoundation.example', 12500000, 9800000, 210000000, 5),
  ('521234567', '202521229349200777', '30777777', '990-EZ', '2024-12', 2024,
   'Promote civic engagement and neighborhood improvement in Riverton.', NULL,
   NULL, 84000, 79000, 51000, 5);

INSERT INTO programs (ein, rank, description, expense, grants, revenue) VALUES
  ('530196605', 1, 'Biomedical services: collection, testing and distribution of blood products.', 1912000000, 0, 1850000000),
  ('530196605', 2, 'Disaster services: shelter, food, emotional support and recovery assistance.', 701000000, 92000000, NULL),
  ('530196605', 3, 'Training services: first aid, CPR and lifeguard certification.', 151000000, NULL, 143000000);
