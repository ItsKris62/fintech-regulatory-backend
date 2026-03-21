# Database Migration Guide

## Overview
This guide documents the schema changes made to add support for:
1. **chunksProcessed** field in GapAnalysis model
2. **RegulatoryFramework** model for managing regulatory frameworks

## Changes Made

### 1. GapAnalysis Model Update
Added `chunksProcessed` field to track the number of chunks processed during gap analysis:

```prisma
model GapAnalysis {
  // ... existing fields ...
  ragGrounded          Boolean  @default(true)
  chunksProcessed      Int      @default(1)  // NEW FIELD
  createdAt            DateTime @default(now())
  // ... rest of fields ...
}
```

**Purpose**: This field tracks how many document chunks have been processed during gap analysis, enabling better progress tracking and analytics.

### 2. RegulatoryFramework Model (New)
Added a new model to manage regulatory frameworks:

```prisma
model RegulatoryFramework {
  id          String   @id @default(cuid())
  slug        String   @unique
  name        String
  category    String
  description String?
  tier        String   @default("STARTUP")
  isActive    Boolean  @default(true)
  sortOrder   Int      @default(0)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

**Purpose**: This model stores regulatory frameworks that can be selected during gap analysis and compliance checks. Frameworks are categorized by tier (STARTUP, BUSINESS, ENTERPRISE).

## Migration Steps

### Step 1: Run the Migration
```bash
cd fintech-regulatory-backend
npx prisma migrate dev --name add_chunks_processed_and_regulatory_framework
```

This command:
- Creates a new migration file
- Applies the changes to your database
- Regenerates the Prisma Client

### Step 2: Seed Regulatory Frameworks
After the migration completes, run the seed SQL to populate the RegulatoryFramework table:

**Option A: Using psql (if you have PostgreSQL client)**
```bash
psql $DATABASE_URL -f prisma/seed-regulatory-frameworks.sql
```

**Option B: Using Prisma Studio**
1. Open Prisma Studio: `npx prisma studio`
2. Navigate to the RegulatoryFramework table
3. Click "Add record" and manually add the frameworks, OR
4. Use the "Raw query" feature to paste and run the SQL from `prisma/seed-regulatory-frameworks.sql`

**Option C: Using a database client (e.g., pgAdmin, DBeaver, TablePlus)**
1. Connect to your database
2. Open the SQL query editor
3. Paste the contents of `prisma/seed-regulatory-frameworks.sql`
4. Execute the query

### Step 3: Verify the Migration
```bash
# Check that the migration was applied
npx prisma migrate status

# Verify the data was seeded (should show 13 frameworks)
npx prisma studio
```

## Seed Data Summary

The seed data includes 13 regulatory frameworks across different tiers:

### STARTUP Tier (6 frameworks)
1. Data Protection Act 2019
2. ODPC Data Protection Regulations 2021
3. CBK Prudential Guidelines
4. National Payment System Act 2011
5. POCAMLA (Anti-Money Laundering)
6. CBK Cybersecurity Guidance Note

### BUSINESS Tier (5 frameworks)
7. Consumer Protection Guidelines
8. Digital Credit Providers Regulations 2022
9. Capital Markets Authority Act
10. Kenya Information and Communications Act
11. Microfinance Act 2006

### ENTERPRISE Tier (2 frameworks)
12. ISO 27001
13. PCI-DSS

## Next Steps

After completing these migrations, you can proceed with:
- **Task 1.7**: Implementing chunksProcessed tracking in gap analysis
- **Task 5.2-5.4**: Building the regulatory framework selection UI and backend logic

## Rollback (if needed)

If you need to rollback this migration:
```bash
npx prisma migrate resolve --rolled-back add_chunks_processed_and_regulatory_framework
```

Then manually revert the schema changes in `prisma/schema.prisma`.

## Files Modified
- `prisma/schema.prisma` - Added chunksProcessed field and RegulatoryFramework model
- `prisma/seed-regulatory-frameworks.sql` - Seed data for regulatory frameworks
- `prisma/migrations/[timestamp]_add_chunks_processed_and_regulatory_framework/` - Migration files

## Notes
- The `chunksProcessed` field defaults to 1 for all existing gap analyses
- All regulatory frameworks are active by default (`isActive: true`)
- Frameworks are ordered by `sortOrder` for consistent display
- The `tier` field determines which subscription plans have access to each framework
