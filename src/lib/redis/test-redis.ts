#!/usr/bin/env tsx

/**
 * Redis Connection Test Script
 * Tests Redis connection, cache operations, rate limiting, and pub/sub
 */

import { redis, checkRedisHealth, getRedisStats } from './client';
import { cache } from './cache.service';
import { rateLimiter } from './rate-limiter';
import { pubsub } from './pubsub';
import { redisConfig } from '../../config/redis.config';

interface TestResult {
  name: string;
  success: boolean;
  message: string;
  duration?: number;
}

const results: TestResult[] = [];

/**
 * Run a test and record result
 */
async function runTest(
  name: string,
  testFn: () => Promise<{ success: boolean; message: string }>
): Promise<void> {
  const startTime = Date.now();
  
  try {
    console.log(`\n🧪 ${name}...`);
    const result = await testFn();
    const duration = Date.now() - startTime;
    
    results.push({
      name,
      success: result.success,
      message: result.message,
      duration,
    });

    if (result.success) {
      console.log(`   ✅ ${result.message} (${duration}ms)`);
    } else {
      console.log(`   ❌ ${result.message} (${duration}ms)`);
    }
  } catch (error: any) {
    const duration = Date.now() - startTime;
    
    results.push({
      name,
      success: false,
      message: error.message,
      duration,
    });

    console.log(`   ❌ Error: ${error.message} (${duration}ms)`);
  }
}

/**
 * Test 1: Basic connection
 */
async function testConnection() {
  return runTest('Redis Connection', async () => {
    const health = await checkRedisHealth();
    
    if (health) {
      return {
        success: true,
        message: 'Connected successfully',
      };
    }

    return {
      success: false,
      message: 'Health check failed',
    };
  });
}

/**
 * Test 2: Get Redis stats
 */
async function testStats() {
  return runTest('Redis Stats', async () => {
    const stats = await getRedisStats();
    
    if (stats.connected) {
      return {
        success: true,
        message: `Memory: ${stats.usedMemory}, Clients: ${stats.connectedClients}`,
      };
    }

    return {
      success: false,
      message: 'Failed to get stats',
    };
  });
}

/**
 * Test 3: Basic cache operations
 */
async function testCacheOperations() {
  return runTest('Cache Operations (Set/Get/Delete)', async () => {
    const testKey = 'test:cache:basic';
    const testValue = { message: 'Hello Redis', timestamp: Date.now() };

    // Set
    await cache.set(testKey, testValue, 60);

    // Get
    const retrieved = await cache.get<typeof testValue>(testKey);
    
    if (!retrieved || retrieved.message !== testValue.message) {
      return {
        success: false,
        message: 'Failed to retrieve cached value',
      };
    }

    // Delete
    await cache.delete(testKey);
    const afterDelete = await cache.get(testKey);
    
    if (afterDelete !== null) {
      return {
        success: false,
        message: 'Failed to delete cached value',
      };
    }

    return {
      success: true,
      message: 'All operations passed',
    };
  });
}

/**
 * Test 4: Cache-aside pattern
 */
async function testCacheAside() {
  return runTest('Cache-Aside Pattern (getOrSet)', async () => {
    const testKey = 'test:cache:aside';
    let fetchCalled = false;

    const fetchFn = async () => {
      fetchCalled = true;
      return { data: 'fetched from source' };
    };

    // First call - should fetch
    await cache.getOrSet(testKey, fetchFn, 60);

    if (!fetchCalled) {
      return {
        success: false,
        message: 'Fetch function not called on cache miss',
      };
    }

    // Second call - should use cache
    fetchCalled = false;
    await cache.getOrSet(testKey, fetchFn, 60);

    if (fetchCalled) {
      return {
        success: false,
        message: 'Fetch function called on cache hit',
      };
    }

    // Clean up
    await cache.delete(testKey);

    return {
      success: true,
      message: 'Cache-aside working correctly',
    };
  });
}

/**
 * Test 5: TTL and expiration
 */
async function testTTL() {
  return runTest('TTL and Expiration', async () => {
    const testKey = 'test:cache:ttl';
    
    // Set with 2 second TTL
    await cache.set(testKey, { data: 'expires soon' }, 2);

    // Check TTL immediately
    const ttl = await cache.getTTL(testKey);
    
    if (ttl <= 0 || ttl > 2) {
      return {
        success: false,
        message: `Unexpected TTL: ${ttl}`,
      };
    }

    // Wait for expiration
    await new Promise(resolve => setTimeout(resolve, 2500));

    // Check if expired
    const expired = await cache.get(testKey);
    
    if (expired !== null) {
      return {
        success: false,
        message: 'Key did not expire',
      };
    }

    return {
      success: true,
      message: 'TTL working correctly',
    };
  });
}

/**
 * Test 6: Rate limiting
 */
async function testRateLimiting() {
  return runTest('Rate Limiting', async () => {
    const identifier = 'test-user';
    const action = 'test-action';
    const max = 3;
    const window = 10;

    // Reset first
    await rateLimiter.reset(identifier, action);

    // Make requests up to limit
    for (let i = 0; i < max; i++) {
      const result = await rateLimiter.check(identifier, action, max, window);
      
      if (!result.allowed) {
        return {
          success: false,
          message: `Request ${i + 1} blocked unexpectedly`,
        };
      }
    }

    // Next request should be blocked
    const blocked = await rateLimiter.check(identifier, action, max, window);
    
    if (blocked.allowed) {
      return {
        success: false,
        message: 'Rate limit not enforced',
      };
    }

    // Clean up
    await rateLimiter.reset(identifier, action);

    return {
      success: true,
      message: `Rate limit enforced (${max} requests)`,
    };
  });
}

/**
 * Test 7: Pub/Sub messaging
 */
async function testPubSub() {
  return runTest('Pub/Sub Messaging', async () => {
    const channel = 'test:channel';
    let receivedMessage: any = null;

    // Subscribe
    const unsubscribe = await pubsub.subscribe(channel, (event: any) => {
      receivedMessage = event;
    });

    // Give subscription time to register
    await new Promise(resolve => setTimeout(resolve, 100));

    // Publish
    const testEvent = { type: 'test', message: 'Hello Pub/Sub', timestamp: Date.now() };
    await pubsub.publish(channel, testEvent);

    // Wait for message
    await new Promise(resolve => setTimeout(resolve, 200));

    // Unsubscribe
    await unsubscribe();

    if (!receivedMessage) {
      return {
        success: false,
        message: 'Message not received',
      };
    }

    if (receivedMessage.message !== testEvent.message) {
      return {
        success: false,
        message: 'Message content mismatch',
      };
    }

    return {
      success: true,
      message: 'Pub/Sub working correctly',
    };
  });
}

/**
 * Test 8: Increment/Decrement
 */
async function testCounters() {
  return runTest('Counter Operations', async () => {
    const testKey = 'test:counter';

    // Clean start
    await redis.del(testKey);

    // Increment
    const val1 = await cache.increment(testKey, 5);
    if (val1 !== 5) {
      return {
        success: false,
        message: `Expected 5, got ${val1}`,
      };
    }

    // Increment again
    const val2 = await cache.increment(testKey, 3);
    if (val2 !== 8) {
      return {
        success: false,
        message: `Expected 8, got ${val2}`,
      };
    }

    // Decrement
    const val3 = await cache.decrement(testKey, 2);
    if (val3 !== 6) {
      return {
        success: false,
        message: `Expected 6, got ${val3}`,
      };
    }

    // Clean up
    await redis.del(testKey);

    return {
      success: true,
      message: 'Counter operations working',
    };
  });
}

/**
 * Test 9: Pattern operations
 */
async function testPatterns() {
  return runTest('Pattern Operations', async () => {
    const prefix = 'test:pattern:';
    
    // Create multiple keys
    await cache.set(`${prefix}1`, { id: 1 }, 60);
    await cache.set(`${prefix}2`, { id: 2 }, 60);
    await cache.set(`${prefix}3`, { id: 3 }, 60);

    // Count keys
    const keys = await redis.keys(`${prefix}*`);
    
    if (keys.length !== 3) {
      return {
        success: false,
        message: `Expected 3 keys, found ${keys.length}`,
      };
    }

    // Delete by pattern
    const deleted = await cache.invalidatePattern(`${prefix}*`);
    
    if (deleted !== 3) {
      return {
        success: false,
        message: `Expected to delete 3 keys, deleted ${deleted}`,
      };
    }

    return {
      success: true,
      message: 'Pattern operations working',
    };
  });
}

/**
 * Test 10: Performance benchmark
 */
async function testPerformance() {
  return runTest('Performance Benchmark', async () => {
    const iterations = 100;
    const testKey = 'test:perf';

    // Set operations
    const setStart = Date.now();
    for (let i = 0; i < iterations; i++) {
      await cache.set(`${testKey}:${i}`, { iteration: i });
    }
    const setDuration = Date.now() - setStart;

    // Get operations
    const getStart = Date.now();
    for (let i = 0; i < iterations; i++) {
      await cache.get(`${testKey}:${i}`);
    }
    const getDuration = Date.now() - getStart;

    // Clean up
    await cache.invalidatePattern(`${testKey}:*`);

    const avgSet = Math.round(setDuration / iterations);
    const avgGet = Math.round(getDuration / iterations);

    return {
      success: true,
      message: `Set: ${avgSet}ms/op, Get: ${avgGet}ms/op (${iterations} operations)`,
    };
  });
}

/**
 * Print summary
 */
function printSummary() {
  console.log('\n' + '='.repeat(60));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(60));

  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const total = results.length;

  console.log(`\nTotal Tests: ${total}`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);

  if (failed > 0) {
    console.log('\n⚠️  Failed Tests:');
    results
      .filter((r) => !r.success)
      .forEach((r) => {
        console.log(`   - ${r.name}: ${r.message}`);
      });
  }

  const avgDuration =
    results.reduce((sum, r) => sum + (r.duration || 0), 0) / results.length;
  console.log(`\n⏱️  Average test duration: ${avgDuration.toFixed(2)}ms`);

  console.log('\n' + '='.repeat(60));

  if (failed === 0) {
    console.log('🎉 All tests passed! Redis is ready to use.');
  } else {
    console.log('⚠️  Some tests failed. Please check configuration.');
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('🧪 SheriaBot Redis Connection Test');
  console.log('='.repeat(60));
  console.log(`Redis URL: ${redisConfig.connection.url.split('@')[1] || 'localhost'}`);
  console.log('='.repeat(60));

  try {
    await testConnection();
    await testStats();
    await testCacheOperations();
    await testCacheAside();
    await testTTL();
    await testRateLimiting();
    await testPubSub();
    await testCounters();
    await testPatterns();
    await testPerformance();

    printSummary();

    process.exit(results.some((r) => !r.success) ? 1 : 0);
  } catch (error: any) {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  } finally {
    await pubsub.disconnect();
    await redis.quit();
  }
}

main();