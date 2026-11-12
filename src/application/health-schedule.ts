import { MemoryError } from '../domain/errors.js';
import { resolveHealth, type AppConfig } from '../config/schema.js';
import type { HealthReport } from './health-service.js';

/**
 * In-process health interval for a long-lived HTTP server.
 * Stdio and one-shot commands do not start it. The timer is unref'd so it
 * cannot keep the process alive on its own. A run that overlaps the previous
 * one is skipped (the service's single-flight lock).
 */
export function startHealthScheduler(
  run: () => Promise<HealthReport>,
  config: AppConfig,
  random: () => number = Math.random,
): () => void {
  const health = resolveHealth(config.health);
  if (!health.enabled || config.transport !== 'http') return () => undefined;
  const intervalMs = health.interval_hours * 60 * 60 * 1000;
  const jitterMs = Math.floor(random() * Math.min(60_000, intervalMs * 0.05));
  const startupMs = health.startup_delay_s * 1000 + Math.floor(random() * 5_000);
  let interval: ReturnType<typeof setInterval> | undefined;
  const tick = () => {
    void run().then(report => {
      process.stderr.write(`health check: ${report.findings.length} findings, ${report.changesets.length} dry-run changesets\n`);
    }).catch(error => {
      if (error instanceof MemoryError && error.code === 'CONFLICT') return;
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`health check failed: ${message}\n`);
    });
  };
  const starter = setTimeout(() => {
    tick();
    interval = setInterval(tick, intervalMs + jitterMs);
    interval.unref();
  }, startupMs);
  starter.unref();
  return () => {
    clearTimeout(starter);
    if (interval) clearInterval(interval);
  };
}
