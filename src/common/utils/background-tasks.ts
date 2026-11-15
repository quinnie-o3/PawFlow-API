import type { Logger } from '@nestjs/common';

/**
 * Fire-and-forget work that runs after the HTTP response (e.g. e-mail
 * delivery). Failures are logged with the label only, never with the task's
 * data. `idle()` lets tests and graceful shutdown wait for pending tasks.
 */
export class BackgroundTasks {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly logger: Pick<Logger, 'error'>) {}

  run(label: string, task: () => Promise<void>): void {
    const promise: Promise<void> = Promise.resolve()
      .then(task)
      .catch((error: unknown) => {
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
        this.logger.error(`${label} failed (${reason})`);
      })
      .finally(() => {
        this.pending.delete(promise);
      });

    this.pending.add(promise);
  }

  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled(this.pending);
    }
  }
}
