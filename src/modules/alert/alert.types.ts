import type { RegulatoryAlert, AlertSubscription, AlertNotification } from '@prisma/client';

export type { RegulatoryAlert, AlertSubscription, AlertNotification };

export interface AlertWithReadStatus extends RegulatoryAlert {
  isRead: boolean;
  notificationId: string | null;
}

export interface GetAlertsResult {
  alerts: AlertWithReadStatus[];
  total: number;
  page: number;
  totalPages: number;
}
