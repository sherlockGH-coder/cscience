export async function* readSseEvents(readableStream, options = {}) {
  const decoder = new TextDecoder();
  const reader = readableStream.getReader();
  const maxBufferBytes = options.maxBufferBytes ?? 8 * 1024 * 1024;
  let buffer = '';
  let eventName = null;
  let dataLines = [];
  let eventId = null;

  try {
    while (true) {
      if (options.signal?.aborted) {
        const abortError = new Error('SSE read aborted');
        abortError.name = 'AbortError';
        throw abortError;
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(buffer, 'utf8') > maxBufferBytes) {
        throw new Error('SSE buffer exceeded limit');
      }

      let newlineIndex;
      while ((newlineIndex = findLineBreak(buffer)) !== -1) {
        const line = buffer.slice(0, newlineIndex.lineEnd);
        buffer = buffer.slice(newlineIndex.nextStart);

        if (line === '') {
          if (dataLines.length > 0 || eventName) {
            yield {
              event: eventName || 'message',
              data: dataLines.join('\n'),
              id: eventId,
            };
          }
          eventName = null;
          dataLines = [];
          eventId = null;
          continue;
        }

        if (line.startsWith(':')) continue;

        const colonIndex = line.indexOf(':');
        const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
        let fieldValue = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
        if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);

        if (field === 'event') {
          eventName = fieldValue;
        } else if (field === 'data') {
          dataLines.push(fieldValue);
        } else if (field === 'id') {
          eventId = fieldValue;
        }
      }
    }

    if (dataLines.length > 0 || eventName) {
      yield {
        event: eventName || 'message',
        data: dataLines.join('\n'),
        id: eventId,
      };
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function findLineBreak(text) {
  const crlf = text.indexOf('\r\n');
  const lf = text.indexOf('\n');
  const cr = text.indexOf('\r');

  let index = -1;
  let length = 1;
  if (crlf !== -1) {
    index = crlf;
    length = 2;
  }
  if (lf !== -1 && (index === -1 || lf < index)) {
    index = lf;
    length = 1;
  }
  if (cr !== -1 && (index === -1 || cr < index)) {
    // bare CR
    if (crlf === cr) {
      // already handled as CRLF
    } else {
      index = cr;
      length = 1;
    }
  }
  if (index === -1) return -1;
  return { lineEnd: index, nextStart: index + length };
}

export async function collectSseJsonEvents(readableStream, options = {}) {
  const events = [];
  for await (const event of readSseEvents(readableStream, options)) {
    if (event.data === '[DONE]') {
      events.push({ event: event.event, data: '[DONE]', raw: true });
      break;
    }
    try {
      events.push({
        event: event.event,
        data: JSON.parse(event.data),
        raw: false,
      });
    } catch {
      events.push({
        event: event.event,
        data: event.data,
        raw: true,
      });
    }
  }
  return events;
}
