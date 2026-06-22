# Blog Source Discovery Engine

This document outlines the architecture and design of the Source Discovery Engine (Sprint 3.3).

## Overview

The Source Discovery Engine is responsible for continuously polling verified regulatory sources to discover new updates (Source Items). It operates safely, ensuring that malicious URLs or internal endpoints are not fetched (SSRF protection).

## Components

### 1. `source-discovery.service.ts`
The core engine. It fetches data based on the monitor's `monitoringMethod`.
- Extracts titles, URLs, summaries, and publication dates.
- Calculates a SHA-256 hash of the content to prevent duplicate entries.
- Validates duplicates against `BlogSourceItem` using `normalizedUrl` and `contentHash`.
- Updates the `BlogDiscoveryRun` and `BlogSourceMonitor` status accordingly.

### 2. URL Safety (`url-safety.ts`)
Strictly validates URLs before fetching.
- Allows only `http:` and `https:` protocols.
- Blocks localhost and loopback addresses.
- Blocks internal IP ranges (10.x.x.x, 192.168.x.x, 172.16.x.x).
- Blocks `.local` and `.internal` domains.

### 3. Distributed Locking (`discovery-lock.ts`)
Ensures that a single monitor is not processed concurrently.
- Uses Upstash Redis with a TTL of 10 minutes.
- Falls back to a local memory Set in development if Redis is unavailable, avoiding application crashes.

### 4. Parsers (`rss-parser.ts`, `html-listing-parser.ts`)
- **RSS Parser**: Uses `rss-parser` to parse XML feeds.
- **HTML Parser**: Uses `cheerio` to extract links from an HTML listing page. This is a basic implementation to find `<a>` tags within the main content area.

### 5. Content Hash (`content-hash.ts`)
Generates a SHA-256 hash of the stringified content to detect when an item is truly identical to a previously discovered one, even if the URL changes slightly.

## Cron Job

A standalone script `src/scripts/blog-source-discovery-cron.ts` is executed periodically to process active, verified monitors. It processes monitors with a concurrency of 2 to avoid overloading the application or Redis.

## Admin Interface

Admins can view the discovered items in the "Source Items" page, inspect them, and dismiss them if irrelevant. They can also manually trigger a discovery run for a verified monitor from the "Blog Sources" registry.
