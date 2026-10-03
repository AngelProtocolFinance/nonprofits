-- Hand-written fixture rows for local dev and tests. Plain INSERTs: a second
-- run fails on the primary keys instead of overwriting real data.
INSERT INTO import_runs (id, source, file_url, released_at, fetched_at, row_count) VALUES
  (1, 'bmf', 'https://www.irs.gov/pub/irs-soi/eo_dc.csv', '2026-09-08T12:00:00.000Z', '2026-09-10T03:00:00.000Z', 6),
  (2, 'pub78', 'https://apps.irs.gov/pub/epostcard/data-download-pub78.zip', '2026-09-01T12:00:00.000Z', '2026-09-10T03:05:00.000Z', 3),
  (3, 'revocation', 'https://apps.irs.gov/pub/epostcard/data-download-revocation.zip', '2026-09-02T12:00:00.000Z', '2026-09-10T03:06:00.000Z', 2),
  (4, 'epostcard', 'https://apps.irs.gov/pub/epostcard/data-download-epostcard.zip', '2026-09-03T12:00:00.000Z', '2026-09-10T03:07:00.000Z', 1),
  (5, 'efile_xml', 'https://apps.irs.gov/pub/epostcard/990/xml/2026/2026_TEOS_XML_05A.zip', '2026-09-04T12:00:00.000Z', '2026-09-10T03:10:00.000Z', 4);

INSERT INTO orgs (
  ein, name, name_run_id, street, city, state, zip, address_run_id,
  bmf_run_id, subsection, ntee, ruling_date, deductibility_code, filing_requirement_code,
  in_pub78, revocation_date, reinstatement_date, files_990n, epostcard_website
) VALUES
  -- fully populated 501(c)(3), 990 filer
  ('530196605', 'AMERICAN NATIONAL RED CROSS', 1, '431 18TH ST NW', 'WASHINGTON', 'DC', '20006-5310', 1,
   1, '03', 'P20', '1946-06', '1', '01', 1, NULL, NULL, 0, NULL),
  -- 990-N (e-Postcard) filer
  ('271234567', 'SUNNYSIDE YOUTH SOCCER LEAGUE', 1, '120 FIELD RD', 'BOISE', 'ID', '83702', 1,
   1, '03', 'N64', '2011-03', '1', '06', 1, NULL, NULL, 1, 'sunnysidesoccer.example'),
  -- private foundation, 990-PF filer
  ('136009999', 'HALVERSEN FAMILY FOUNDATION', 1, '50 PARK AVE', 'NEW YORK', 'NY', '10016-3005', 1,
   1, '03', 'T20', '1958-11', '1', '01', 1, NULL, NULL, 0, NULL),
  -- revoked, still in the BMF
  ('201234567', 'LAPSED COMMUNITY THEATER INC', 1, '9 MAIN ST', 'DAYTON', 'OH', '45402', 1,
   1, '03', 'A65', '2004-08', '1', '01', 0, '2023-05-15', NULL, 0, NULL),
  -- revoked and dropped from the BMF: known only from the revocation list
  ('311234567', 'DEFUNCT ARTS COUNCIL', 3, '1 OLD RD', 'TOLEDO', 'OH', '43604', 3,
   NULL, NULL, NULL, NULL, NULL, NULL, 0, '2019-05-15', NULL, 0, NULL),
  -- 501(c)(4), not deductible, 990-EZ filer
  ('521234567', 'GREATER RIVERTON CIVIC LEAGUE', 1, '300 ELM ST', 'RIVERTON', 'WY', '82501', 1,
   1, '04', 'S20', '1979-02', '2', '01', 0, NULL, NULL, 0, NULL),
  -- 990 filer whose mission field only says "SEE SCHEDULE O"
  ('010654321', 'HARBORVIEW LITERACY PROJECT', 1, '18 WHARF ST', 'PORTLAND', 'ME', '04101', 1,
   1, '03', 'B60', '1998-04', '1', '01', 1, NULL, NULL, 0, NULL);

INSERT INTO filings (
  ein, object_id, return_id, form_type, tax_period, tax_year, mission,
  activity_summary, website, total_revenue, total_expenses, total_assets_eoy, run_id,
  mission_on_schedule_o
) VALUES
  ('530196605', '202511319349301234', '31234567', '990', '2025-06', 2024,
   'The American Red Cross prevents and alleviates human suffering in the face of emergencies by mobilizing the power of volunteers and the generosity of donors.',
   'Disaster relief, biomedical services, training and services to the armed forces.',
   'https://www.redcross.org', 3215000000, 3108000000, 4021000000, 5, 0),
  ('136009999', '202501239349100500', '30500500', '990-PF', '2024-12', 2024,
   NULL, NULL, 'https://halversenfoundation.example', 12500000, 9800000, 210000000, 5, 0),
  ('521234567', '202521229349200777', '30777777', '990-EZ', '2024-12', 2024,
   'Promote civic engagement and neighborhood improvement in Riverton.', NULL,
   NULL, 84000, 79000, 51000, 5, 0),
  ('010654321', '202531329349300421', '30421421', '990', '2025-06', 2024,
   NULL, 'Free tutoring and book distribution for adult learners.',
   'https://harborviewliteracy.example', 412000, 398000, 260000, 5, 1);

INSERT INTO programs (ein, object_id, rank, description, expense, grants, revenue) VALUES
  ('530196605', '202511319349301234', 1, 'Biomedical services: collection, testing and distribution of blood products.', 1912000000, 0, 1850000000),
  ('530196605', '202511319349301234', 2, 'Disaster services: shelter, food, emotional support and recovery assistance.', 701000000, 92000000, NULL),
  ('530196605', '202511319349301234', 3, 'Training services: first aid, CPR and lifeguard certification.', 151000000, NULL, 143000000);
