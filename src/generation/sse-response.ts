import type { Response } from 'express';

type SseEvent =
  | ['status', { status: 'waiting' | 'generating' }]
  | ['content', { delta: string }]
  | ['completed', { status: 'completed' }]
  | ['error', { message: string }];

/** One instance per HTTP response; never shared across generations. */
export class SseResponse {
  private disconnected = false;
  private readonly onClose = (): void => {
    if (this.disconnected) return;
    this.disconnected = true;
    if (!this.response.writableEnded) this.onDisconnect();
  };

  constructor(
    private readonly response: Response,
    private readonly onDisconnect: () => void = () => {},
  ) {
    response.once('close', this.onClose);
    response.once('error', this.onClose);
    if (response.destroyed && !response.writableEnded) this.onClose();
  }

  get closed(): boolean {
    return this.disconnected || this.response.destroyed || this.response.writableEnded;
  }

  open(): void {
    if (this.closed) return;
    this.response.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    this.response.flushHeaders();
  }

  async send(...[event, data]: SseEvent): Promise<boolean> {
    if (this.closed) return false;
    try {
      if (this.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) return true;
      // Respect socket backpressure without accumulating the full response.
      await new Promise<void>((resolve) => {
        const done = (): void => {
          this.response.off('drain', done);
          this.response.off('close', done);
          this.response.off('error', done);
          resolve();
        };
        this.response.once('drain', done);
        this.response.once('close', done);
        this.response.once('error', done);
        if (this.closed) done();
      });
      return !this.closed;
    } catch {
      this.onClose();
      return false;
    }
  }

  end(): void {
    if (!this.closed && this.response.headersSent) this.response.end();
    this.response.off('close', this.onClose);
    this.response.off('error', this.onClose);
  }
}
