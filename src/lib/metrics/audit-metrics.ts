/**
 * Audit Failure Metrics
 *
 * Tracks failure counters for background audit log writes (F-10).
 * Exposes Prometheus / OpenMetrics counters for scraping at /metrics.
 */

export interface AuditMetricsState {
  failures: number;
  byType: Record<string, number>;
}

class AuditMetrics {
  private failures = 0;
  private byType: Record<string, number> = {};

  incrementFailure(type: string): void {
    this.failures++;
    this.byType[type] = (this.byType[type] ?? 0) + 1;
  }

  getMetrics(): AuditMetricsState {
    return {
      failures: this.failures,
      byType: { ...this.byType },
    };
  }

  formatPrometheus(): string {
    const lines: string[] = [
      '# HELP sheriabot_audit_write_failures_total Total number of failed background audit log writes (F-10).',
      '# TYPE sheriabot_audit_write_failures_total counter',
      `sheriabot_audit_write_failures_total ${this.failures}`,
    ];

    for (const [type, count] of Object.entries(this.byType)) {
      lines.push(`sheriabot_audit_write_failures_by_type{type="${type}"} ${count}`);
    }

    return lines.join('\n');
  }

  reset(): void {
    this.failures = 0;
    this.byType = {};
  }
}

export const auditMetrics = new AuditMetrics();
