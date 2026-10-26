/**
 * Incremental Server-Sent Events parser.
 *
 * Network chunks do not line up with events: one chunk can hold half an event, or three. We buffer
 * until a blank line ends an event, then hand back the event's exact original text (so it can be
 * forwarded byte-for-byte) along with its parsed `event:` name and `data:` payload.
 */
export interface SseEvent {
  raw: string;
  event?: string;
  data: string;
}

const BOUNDARY = /\r?\n\r?\n/;

export class SseParser {
  private buffer = '';
  private decoder = new TextDecoder();

  push(chunk: Uint8Array): SseEvent[] {
    // stream: true keeps a multi-byte character split across chunks intact.
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const events: SseEvent[] = [];
    let match: RegExpExecArray | null;
    while ((match = BOUNDARY.exec(this.buffer))) {
      const end = match.index + match[0].length;
      events.push(parseEvent(this.buffer.slice(0, end)));
      this.buffer = this.buffer.slice(end);
    }
    return events;
  }

  /** Whatever is left when the stream ends without a final blank line. */
  flush(): SseEvent | null {
    this.buffer += this.decoder.decode();
    const rest = this.buffer;
    this.buffer = '';
    return rest.trim() ? parseEvent(rest) : null;
  }
}

function parseEvent(raw: string): SseEvent {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return { raw, event, data: data.join('\n') };
}
