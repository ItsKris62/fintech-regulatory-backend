import { EventEmitter } from 'events';
import { getNotificationChannel, getPolicyProgressChannel, redisConfig } from '@/config/redis.config';
import { logger } from '@/utils/logger';

/**
 * In-process Pub/Sub service using Node.js EventEmitter.
 *
 * Replaces the ioredis TCP pub/sub implementation, which is incompatible
 * with Upstash's HTTP-based REST API.
 *
 * Trade-off: events are process-local only. For a single-instance Render
 * deployment this is identical in behaviour to Redis pub/sub. If you ever
 * move to multiple replicas, replace this with Upstash QStash or similar.
 */

export type NotificationEvent = {
  type: string;
  userId: string;
  data: any;
  timestamp: number;
};

export type PolicyProgressEvent = {
  type:
    | 'generation_started'
    | 'analyzing_regulations'
    | 'generating_recommendations'
    | 'creating_checklist'
    | 'generation_complete'
    | 'generation_failed';
  policyId: string;
  progress: number;
  message: string;
  data?: any;
  timestamp: number;
};

export type EventHandler<T> = (event: T) => void | Promise<void>;

class PubSubService {
  private emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
  }

  async publish<T>(channel: string, event: T): Promise<void> {
    try {
      this.emitter.emit(channel, event);
      logger.debug({ type: 'pubsub_published', channel });
    } catch (error: any) {
      logger.error({ type: 'pubsub_publish_error', channel, error: error.message });
    }
  }

  async subscribe<T>(channel: string, handler: EventHandler<T>): Promise<() => void> {
    this.emitter.on(channel, handler as any);
    logger.info({ type: 'pubsub_subscribed', channel });
    return () => this.unsubscribe(channel, handler);
  }

  async unsubscribe<T>(channel: string, handler: EventHandler<T>): Promise<void> {
    this.emitter.off(channel, handler as any);
  }

  async unsubscribeAll(): Promise<void> {
    this.emitter.removeAllListeners();
    logger.info('Unsubscribed from all channels');
  }

  async disconnect(): Promise<void> {
    await this.unsubscribeAll();
    logger.info('Pub/Sub disconnected');
  }
}

export const pubsub = new PubSubService();

export const notificationPubSub = {
  publish: async (userId: string, notification: Omit<NotificationEvent, 'timestamp'>) => {
    const channel = getNotificationChannel(userId);
    await pubsub.publish<NotificationEvent>(channel, { ...notification, timestamp: Date.now() });
  },
  subscribe: async (userId: string, handler: EventHandler<NotificationEvent>) => {
    return pubsub.subscribe(getNotificationChannel(userId), handler);
  },
  unsubscribe: async (userId: string, handler: EventHandler<NotificationEvent>) => {
    return pubsub.unsubscribe(getNotificationChannel(userId), handler);
  },
};

export const policyProgressPubSub = {
  publish: async (policyId: string, event: Omit<PolicyProgressEvent, 'policyId' | 'timestamp'>) => {
    const channel = getPolicyProgressChannel(policyId);
    await pubsub.publish<PolicyProgressEvent>(channel, { ...event, policyId, timestamp: Date.now() });
  },
  subscribe: async (policyId: string, handler: EventHandler<PolicyProgressEvent>) => {
    return pubsub.subscribe(getPolicyProgressChannel(policyId), handler);
  },
  unsubscribe: async (policyId: string, handler: EventHandler<PolicyProgressEvent>) => {
    return pubsub.unsubscribe(getPolicyProgressChannel(policyId), handler);
  },
  started:   (policyId: string) => policyProgressPubSub.publish(policyId, { type: 'generation_started',         progress: 0,   message: 'Starting policy generation...' }),
  analyzing: (policyId: string) => policyProgressPubSub.publish(policyId, { type: 'analyzing_regulations',      progress: 25,  message: 'Analyzing relevant regulations...' }),
  generating:(policyId: string) => policyProgressPubSub.publish(policyId, { type: 'generating_recommendations', progress: 50,  message: 'Generating policy recommendations...' }),
  checklist: (policyId: string) => policyProgressPubSub.publish(policyId, { type: 'creating_checklist',         progress: 75,  message: 'Creating compliance checklist...' }),
  complete:  (policyId: string, data?: any) => policyProgressPubSub.publish(policyId, { type: 'generation_complete', progress: 100, message: 'Policy generation complete!', data }),
  failed:    (policyId: string, error: string) => policyProgressPubSub.publish(policyId, { type: 'generation_failed', progress: 0, message: 'Policy generation failed', data: { error } }),
};

export const systemEventsPubSub = {
  publish: async (event: { type: string; message: string; data?: any }) => {
    await pubsub.publish(redisConfig.channels.systemEvents, { ...event, timestamp: Date.now() });
  },
  subscribe: async (handler: EventHandler<any>) => {
    return pubsub.subscribe(redisConfig.channels.systemEvents, handler);
  },
};
