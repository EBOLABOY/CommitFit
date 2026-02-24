import type { SSERoutingEvent, SSESupplementEvent, OrchestrateAutoWriteSummary } from '../../../shared/types';

export class SSEStreamWriter {
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private encoder = new TextEncoder();
  private closed = false;

  constructor(writer: WritableStreamDefaultWriter<Uint8Array>) {
    this.writer = writer;
  }

  private async write(data: string): Promise<void> {
    if (this.closed) return;
    try {
      await this.writer.write(this.encoder.encode(data));
    } catch {
      this.closed = true;
    }
  }

  async sendStatus(message: string): Promise<void> {
    await this.write(`event: status\ndata: ${JSON.stringify({ message })}\n\n`);
  }

  async sendRouting(routing: SSERoutingEvent): Promise<void> {
    await this.write(`event: routing\ndata: ${JSON.stringify(routing)}\n\n`);
  }

  async sendSupplement(role: string, roleName: string, content: string): Promise<void> {
    const event: SSESupplementEvent = { role: role as SSESupplementEvent['role'], role_name: roleName, content };
    await this.write(`event: supplement\ndata: ${JSON.stringify(event)}\n\n`);
  }

  async sendWriteback(summary: OrchestrateAutoWriteSummary): Promise<void> {
    await this.write(`event: writeback\ndata: ${JSON.stringify(summary)}\n\n`);
  }

  async sendWritebackError(error: string): Promise<void> {
    await this.write(`event: writeback_error\ndata: ${JSON.stringify({ error })}\n\n`);
  }

  async sendError(error: string): Promise<void> {
    await this.write(`event: error\ndata: ${JSON.stringify({ error })}\n\n`);
  }

  async sendDone(): Promise<void> {
    await this.write(`event: done\ndata: {}\n\n`);
  }

  /** Write raw bytes (for LLM SSE passthrough). */
  async writeRaw(chunk: Uint8Array): Promise<void> {
    if (this.closed) return;
    try {
      await this.writer.write(chunk);
    } catch {
      this.closed = true;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.writer.close();
    } catch {
      // ignore
    }
  }
}
