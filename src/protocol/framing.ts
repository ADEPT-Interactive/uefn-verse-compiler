export const MAX_PROTOCOL_MESSAGE_BYTES = 10 * 1024 * 1024;

export function encodeContentLengthJson(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_PROTOCOL_MESSAGE_BYTES) throw new Error('Workflow request exceeds the protocol message limit.');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

export class ContentLengthDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): string[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_PROTOCOL_MESSAGE_BYTES + 4096) throw new Error('Workflow response exceeded the protocol buffer limit.');
    const messages: string[] = [];
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        if (this.buffer.length > 4096) throw new Error('Workflow response header exceeded the protocol limit.');
        return messages;
      }
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
      if (!match) throw new Error('Workflow response omitted Content-Length.');
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PROTOCOL_MESSAGE_BYTES) throw new Error('Workflow response declared an invalid message length.');
      const messageEnd = headerEnd + 4 + length;
      if (this.buffer.length < messageEnd) return messages;
      messages.push(this.buffer.subarray(headerEnd + 4, messageEnd).toString('utf8'));
      this.buffer = this.buffer.subarray(messageEnd);
    }
  }
}
