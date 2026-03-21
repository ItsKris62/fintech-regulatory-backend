-- Seed data for RegulatoryFramework table
-- Run this after the migration to populate the regulatory frameworks

INSERT INTO "RegulatoryFramework" (id, slug, name, category, description, tier, "isActive", "sortOrder", "createdAt", "updatedAt") VALUES
  (gen_random_uuid()::text, 'dpa-2019',           'Data Protection Act 2019',                     'Data Protection',       NULL, 'STARTUP',    true,  1,  NOW(), NOW()),
  (gen_random_uuid()::text, 'odpc-regs-2021',     'ODPC Data Protection Regulations 2021',         'Data Protection',       NULL, 'STARTUP',    true,  2,  NOW(), NOW()),
  (gen_random_uuid()::text, 'cbk-prudential',     'CBK Prudential Guidelines',                     'Banking',               NULL, 'STARTUP',    true,  3,  NOW(), NOW()),
  (gen_random_uuid()::text, 'nps-2011',           'National Payment System Act 2011',              'Payments',              NULL, 'STARTUP',    true,  4,  NOW(), NOW()),
  (gen_random_uuid()::text, 'pocamla',            'POCAMLA (Anti-Money Laundering)',               'AML/CFT',               NULL, 'STARTUP',    true,  5,  NOW(), NOW()),
  (gen_random_uuid()::text, 'cbk-cyber',          'CBK Cybersecurity Guidance Note',               'Cybersecurity',         NULL, 'STARTUP',    true,  6,  NOW(), NOW()),
  (gen_random_uuid()::text, 'consumer-protection','Consumer Protection Guidelines',                'Consumer Protection',   NULL, 'BUSINESS',   true,  7,  NOW(), NOW()),
  (gen_random_uuid()::text, 'dcpr-2022',          'Digital Credit Providers Regulations 2022',     'Lending',               NULL, 'BUSINESS',   true,  8,  NOW(), NOW()),
  (gen_random_uuid()::text, 'cma-act',            'Capital Markets Authority Act',                 'Capital Markets',       NULL, 'BUSINESS',   true,  9,  NOW(), NOW()),
  (gen_random_uuid()::text, 'kica',               'Kenya Information and Communications Act',      'ICT',                   NULL, 'BUSINESS',   true,  10, NOW(), NOW()),
  (gen_random_uuid()::text, 'microfinance-2006',  'Microfinance Act 2006',                         'Lending',               NULL, 'BUSINESS',   true,  11, NOW(), NOW()),
  (gen_random_uuid()::text, 'iso-27001',          'ISO 27001',                                     'International Standards',NULL, 'ENTERPRISE', true,  12, NOW(), NOW()),
  (gen_random_uuid()::text, 'pci-dss',            'PCI-DSS',                                       'International Standards',NULL, 'ENTERPRISE', true,  13, NOW(), NOW());
