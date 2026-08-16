# Prisma Database Setup

This directory contains the Prisma schema and database utilities for SheriaBot.

## 📁 Structure

```
prisma/
├── schema.prisma    # Database schema definition
├── seed.ts          # Seed script with Kenyan test data
└── migrations/      # Database migrations (auto-generated)
```

## 🚀 Getting Started

### 1. Environment Setup

Ensure your `.env` file has the correct `DATABASE_URL`:

```bash
# Supabase PostgreSQL (production on Render)
DATABASE_URL="postgresql://postgres:password@host:port/database?connection_limit=5&pool_timeout=20"

# Local PostgreSQL (development)
DATABASE_URL="postgresql://postgres:password@localhost:5432/sheriabot_dev"
```

### 2. Generate Prisma Client

After any schema changes, regenerate the Prisma Client:

```bash
npm run prisma:generate
# or
npx prisma generate
```

### 3. Create and Apply Migrations

For development:

```bash
npm run db:migrate
# or
npx prisma migrate dev --name your_migration_name
```

For production (Render):

```bash
npx prisma migrate deploy
```

### 4. Seed the Database

Populate with Kenyan test data:

```bash
npm run db:seed
# or
npx prisma db seed
```

## 📊 Default Test Users

The seed script creates the following test users (all with password `Test@123`):

### Admin

- **Email:** admin@sheriabot.com
- **Role:** ADMIN
- **Purpose:** System administration

### Regulators (CBK)

- **Email:** wanjiru.kamau@centralbank.go.ke
- **Role:** REGULATOR
- **Organization:** Central Bank of Kenya

- **Email:** john.omondi@centralbank.go.ke
- **Role:** REGULATOR
- **Organization:** Central Bank of Kenya

### Regulator (ODPC)

- **Email:** sarah.muthoni@odpc.go.ke
- **Role:** REGULATOR
- **Organization:** Office of the Data Protection Commissioner

### Startups

- **Email:** james.kiplagat@mpesainnovations.co.ke
- **Role:** STARTUP
- **Organization:** Mpesa Innovations Ltd

- **Email:** grace.njeri@pesacredit.co.ke
- **Role:** STARTUP
- **Organization:** Pesa Credit Technologies

- **Email:** david.otieno@pesacredit.co.ke
- **Role:** STARTUP
- **Organization:** Pesa Credit Technologies

### Enterprise

- **Email:** compliance@kcb.co.ke
- **Role:** ENTERPRISE
- **Organization:** KCB Bank Kenya

## 🔧 Useful Commands

### View Database in Prisma Studio

```bash
npm run prisma:studio
# or
npx prisma studio
```

### Reset Database (⚠️ Deletes all data)

```bash
npm run db:reset
# or
npx prisma migrate reset
```

This will:

1. Drop the database
2. Create a new database
3. Apply all migrations
4. Run the seed script

### Push Schema Without Migration (Development)

```bash
npm run db:push
# or
npx prisma db push
```

Use this for quick prototyping. It syncs your schema without creating migration files.

### Validate Schema

```bash
npx prisma validate
```

### Format Schema

```bash
npx prisma format
```

## 📝 Schema Overview

### Core Models

- **User** - System users (Admin, Regulator, Startup, Enterprise)
- **Organization** - Companies and regulatory bodies
- **Session** - User authentication sessions

### Policy Generation

- **Policy** - Generated regulatory policy frameworks
- **Citation** - Legal citations within policies
- **Comment** - Collaborative comments on policies

### Legal Corpus

- **LegalDocument** - Kenyan laws and regulations
- **DocumentChunk** - Text chunks with embeddings for RAG

### Compliance

- **ComplianceQuery** - Startup compliance questions
- **Checklist** - Compliance checklists and tasks

### System

- **Notification** - User notifications
- **AuditLog** - System audit trail
- **ApiKey** - API access keys
- **UsageMetric** - Usage analytics

## 🔐 Database Security

### Connection Pooling

The Prisma client is configured with conservative pooling for the Render web service and Supabase PostgreSQL:

```typescript
// In src/lib/prisma/client.ts
connectionLimit: 5,
poolTimeout: 20,
```

### Soft Deletes

Soft delete middleware is implemented for:

- User
- Organization
- Policy
- LegalDocument

Records are marked as `deletedAt` instead of being permanently removed.

### Automatic Timestamps

Middleware automatically updates `updatedAt` timestamps on update operations.

## 🐛 Troubleshooting

### Connection Issues

If you get connection errors:

1. Check DATABASE_URL is correct
2. Ensure PostgreSQL is running
3. Verify firewall allows connection
4. Check Supabase connection limits and whether the app is using the pooled URL

### Migration Conflicts

If migrations fail:

```bash
# Reset database (development only)
npx prisma migrate reset

# Or manually resolve conflicts
npx prisma migrate resolve --rolled-back "migration_name"
```

### Prisma Client Out of Sync

If you get "Prisma Client out of sync" errors:

```bash
npx prisma generate
```

## 📚 Documentation

- [Prisma Documentation](https://www.prisma.io/docs)
- [Prisma Best Practices](https://www.prisma.io/docs/guides/performance-and-optimization/connection-management)

## 🚀 Production Deployment

Render runs the production lifecycle from `render.yaml`:

```bash
npm ci && npm run build:prod
npm run start:prod
```

The `prestart:prod` lifecycle script runs `prisma migrate deploy` before `dist/index.js` starts.

## 📞 Support

For Prisma-related issues:

1. Check the [Prisma GitHub Issues](https://github.com/prisma/prisma/issues)
2. Join the [Prisma Slack Community](https://slack.prisma.io/)
3. Review Supabase PostgreSQL and Render service logs
