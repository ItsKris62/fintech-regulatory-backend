import Redis from 'ioredis';
import { redisConfig, getNotificationChannel, getPolicyProgressChannel } from '@/config/redis.config';
import { logger } from '@/utils/logger';

/**
 * Notification event types
 */
export type NotificationEvent = {
  type: string;
  userId: string;
  data: any;
  timestamp: number;
};

/**
 * Policy progress event types
 */
export type PolicyProgressEvent = {
  type: 'generation_started' | 'analyzing_regulations' | 'generating_recommendations' | 
        'creating_checklist' | 'generation_complete' | 'generation_failed';
  policyId: string;
  progress: number; // 0-100
  message: string;
  data?: any;
  timestamp: number;
};

/**
 * Event handler type
 */
export type EventHandler<T> = (event: T) => void | Promise<void>;

/**
 * Redis Pub/Sub service for real-time events
 * Uses separate Redis connections for pub and sub
 */
export class PubSubService {
  private publisher: Redis;
  private subscriber: Redis;
  private handlers: Map<string, Set<EventHandler<any>>>;

  constructor() {
    // Create separate connections for publishing and subscribing
    this.publisher = new Redis(redisConfig.connection.url);
    this.subscriber = new Redis(redisConfig.connection.url);
    this.handlers = new Map();

    this.setupSubscriber();
  }

  /**
   * Set up subscriber event handlers
   */
  private setupSubscriber() {
    this.subscriber.on('message', (channel: string, message: string) => {
      try {
        const event = JSON.parse(message);
        this.handleMessage(channel, event);
      } catch (error: any) {
        logger.error({
          type: 'pubsub_parse_error',
          channel,
          error: error.message,
        });
      }
    });

    this.subscriber.on('error', (error: Error) => {
      logger.error({
        type: 'pubsub_subscriber_error',
        error: error.message,
      });
    });

    this.subscriber.on('ready', () => {
      logger.info('Pub/Sub subscriber ready');
    });
  }

  /**
   * Handle incoming message
   */
  private handleMessage(channel: string, event: any) {
    const handlers = this.handlers.get(channel);
    
    if (!handlers || handlers.size === 0) {
      return;
    }

    handlers.forEach(handler => {
      try {
        handler(event);
      } catch (error: any) {
        logger.error({
          type: 'pubsub_handler_error',
          channel,
          error: error.message,
        });
      }
    });
  }

  /**
   * Publish event to channel
   * @param channel Channel name
   * @param event Event data
   */
  async publish<T>(channel: string, event: T): Promise<void> {
    try {
      const message = JSON.stringify(event);
      await this.publisher.publish(channel, message);

      logger.debug({
        type: 'pubsub_published',
        channel,
        event: typeof event === 'object' ? (event as any).type : 'unknown',
      });
    } catch (error: any) {
      logger.error({
        type: 'pubsub_publish_error',
        channel,
        error: error.message,
      });
    }
  }

  /**
   * Subscribe to channel
   * @param channel Channel name
   * @param handler Event handler
   * @returns Unsubscribe function
   */
  async subscribe<T>(
    channel: string,
    handler: EventHandler<T>
  ): Promise<() => void> {
    try {
      // Add handler to map
      if (!this.handlers.has(channel)) {
        this.handlers.set(channel, new Set());
        // Subscribe to channel if first handler
        await this.subscriber.subscribe(channel);
        
        logger.info({
          type: 'pubsub_subscribed',
          channel,
        });
      }

      this.handlers.get(channel)!.add(handler);

      // Return unsubscribe function
      return () => this.unsubscribe(channel, handler);
    } catch (error: any) {
      logger.error({
        type: 'pubsub_subscribe_error',
        channel,
        error: error.message,
      });
      return () => {};
    }
  }

  /**
   * Unsubscribe from channel
   * @param channel Channel name
   * @param handler Event handler to remove
   */
  async unsubscribe<T>(channel: string, handler: EventHandler<T>): Promise<void> {
    const handlers = this.handlers.get(channel);
    
    if (!handlers) {
      return;
    }

    handlers.delete(handler);

    // If no more handlers, unsubscribe from channel
    if (handlers.size === 0) {
      this.handlers.delete(channel);
      await this.subscriber.unsubscribe(channel);
      
      logger.info({
        type: 'pubsub_unsubscribed',
        channel,
      });
    }
  }

  /**
   * Unsubscribe from all channels
   */
  async unsubscribeAll(): Promise<void> {
    try {
      await this.subscriber.unsubscribe();
      this.handlers.clear();
      
      logger.info('Unsubscribed from all channels');
    } catch (error: any) {
      logger.error({
        type: 'pubsub_unsubscribe_all_error',
        error: error.message,
      });
    }
  }

  /**
   * Disconnect pub/sub connections
   */
  async disconnect(): Promise<void> {
    try {
      await this.unsubscribeAll();
      await this.publisher.quit();
      await this.subscriber.quit();
      
      logger.info('Pub/Sub disconnected');
    } catch (error: any) {
      logger.error({
        type: 'pubsub_disconnect_error',
        error: error.message,
      });
    }
  }
}

/**
 * Export singleton pub/sub service
 */
export const pubsub = new PubSubService();

/**
 * User notification helpers
 */
export const notificationPubSub = {
  /**
   * Publish notification to user
   */
  publish: async (userId: string, notification: Omit<NotificationEvent, 'timestamp'>) => {
    const channel = getNotificationChannel(userId);
    const event: NotificationEvent = {
      ...notification,
      timestamp: Date.now(),
    };
    
    await pubsub.publish(channel, event);
  },

  /**
   * Subscribe to user notifications
   */
  subscribe: async (userId: string, handler: EventHandler<NotificationEvent>) => {
    const channel = getNotificationChannel(userId);
    return await pubsub.subscribe(channel, handler);
  },

  /**
   * Unsubscribe from user notifications
   */
  unsubscribe: async (userId: string, handler: EventHandler<NotificationEvent>) => {
    const channel = getNotificationChannel(userId);
    await pubsub.unsubscribe(channel, handler);
  },
};

/**
 * Policy generation progress helpers
 */
export const policyProgressPubSub = {
  /**
   * Publish policy generation progress
   */
  publish: async (
    policyId: string,
    event: Omit<PolicyProgressEvent, 'policyId' | 'timestamp'>
  ) => {
    const channel = getPolicyProgressChannel(policyId);
    const fullEvent: PolicyProgressEvent = {
      ...event,
      policyId,
      timestamp: Date.now(),
    };
    
    await pubsub.publish(channel, fullEvent);
  },

  /**
   * Subscribe to policy generation progress
   */
  subscribe: async (policyId: string, handler: EventHandler<PolicyProgressEvent>) => {
    const channel = getPolicyProgressChannel(policyId);
    return await pubsub.subscribe(channel, handler);
  },

  /**
   * Unsubscribe from policy generation progress
   */
  unsubscribe: async (policyId: string, handler: EventHandler<PolicyProgressEvent>) => {
    const channel = getPolicyProgressChannel(policyId);
    await pubsub.unsubscribe(channel, handler);
  },

  /**
   * Publish generation started event
   */
  started: async (policyId: string) => {
    await policyProgressPubSub.publish(policyId, {
      type: 'generation_started',
      progress: 0,
      message: 'Starting policy generation...',
    });
  },

  /**
   * Publish analyzing regulations event
   */
  analyzing: async (policyId: string) => {
    await policyProgressPubSub.publish(policyId, {
      type: 'analyzing_regulations',
      progress: 25,
      message: 'Analyzing relevant regulations...',
    });
  },

  /**
   * Publish generating recommendations event
   */
  generating: async (policyId: string) => {
    await policyProgressPubSub.publish(policyId, {
      type: 'generating_recommendations',
      progress: 50,
      message: 'Generating policy recommendations...',
    });
  },

  /**
   * Publish creating checklist event
   */
  checklist: async (policyId: string) => {
    await policyProgressPubSub.publish(policyId, {
      type: 'creating_checklist',
      progress: 75,
      message: 'Creating compliance checklist...',
    });
  },

  /**
   * Publish generation complete event
   */
  complete: async (policyId: string, data?: any) => {
    await policyProgressPubSub.publish(policyId, {
      type: 'generation_complete',
      progress: 100,
      message: 'Policy generation complete!',
      data,
    });
  },

  /**
   * Publish generation failed event
   */
  failed: async (policyId: string, error: string) => {
    await policyProgressPubSub.publish(policyId, {
      type: 'generation_failed',
      progress: 0,
      message: 'Policy generation failed',
      data: { error },
    });
  },
};

/**
 * System events channel
 */
export const systemEventsPubSub = {
  /**
   * Publish system event
   */
  publish: async (event: { type: string; message: string; data?: any }) => {
    const channel = redisConfig.channels.systemEvents;
    await pubsub.publish(channel, {
      ...event,
      timestamp: Date.now(),
    });
  },

  /**
   * Subscribe to system events
   */
  subscribe: async (handler: EventHandler<any>) => {
    const channel = redisConfig.channels.systemEvents;
    return await pubsub.subscribe(channel, handler);
  },
};

/**
 * Clean up on shutdown
 */
process.on('beforeExit', async () => {
  await pubsub.disconnect();
});