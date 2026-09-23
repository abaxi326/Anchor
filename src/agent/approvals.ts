import type { ApprovalRequest } from '../shared';

export class ApprovalBroker {
  private pending = new Map<string, (approved: boolean) => void>();

  constructor(private readonly emit: (request: ApprovalRequest) => void) {}

  request(request: ApprovalRequest, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted || this.pending.has(request.id)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (approved: boolean) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancel);
        this.pending.delete(request.id);
        resolve(approved && !signal?.aborted);
      };
      const cancel = () => finish(false);
      // A lost editor connection must never leave a tool approved by default.
      const timeout = setTimeout(cancel, 10 * 60 * 1000);
      this.pending.set(request.id, finish);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      else this.emit(request);
    });
  }

  answer(id: string, approved: boolean): void { this.pending.get(id)?.(approved); }
  cancelAll(): void { for (const resolve of [...this.pending.values()]) resolve(false); }
}
