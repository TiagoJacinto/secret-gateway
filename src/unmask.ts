// Lookup: replaces placeholders in tool-use inputs of responses, for plain JSON and for streamed
// partial JSON. Text blocks are never changed.
const PLACEHOLDER = /⟦SECRET_[0-9a-f]{6,64}⟧/g;
const MAX_HELD = 80;

export type Lookup = (placeholder: string) => Promise<string | undefined>;

async function replaceAll(text: string, lookup: Lookup, asJsonString: boolean): Promise<string> {
  const values = new Map<string, string>();
  for (const placeholder of new Set(text.match(PLACEHOLDER) ?? [])) {
    const value = await lookup(placeholder);
    if (value !== undefined) values.set(placeholder, value);
  }
  return text.replace(PLACEHOLDER, (placeholder) => {
    const value = values.get(placeholder);
    if (value === undefined) return placeholder;
    // Inside a streamed JSON string the value must be escaped to stay valid JSON.
    return asJsonString ? JSON.stringify(value).slice(1, -1) : value;
  });
}

// Index where an unfinished placeholder starts, or the text length when nothing is pending.
function pendingStart(text: string): number {
  const start = text.lastIndexOf('⟦');
  if (start === -1 || text.indexOf('⟧', start) !== -1 || text.length - start > MAX_HELD) return text.length;
  return start;
}

class ToolInputRestorer {
  #held = '';
  readonly #lookup: Lookup;

  constructor(lookup: Lookup) {
    this.#lookup = lookup;
  }

  async push(fragment: string): Promise<string> {
    const text = this.#held + fragment;
    const cut = pendingStart(text);
    this.#held = text.slice(cut);
    return replaceAll(text.slice(0, cut), this.#lookup, true);
  }

  async flush(): Promise<string> {
    const rest = this.#held;
    this.#held = '';
    return replaceAll(rest, this.#lookup, true);
  }
}

export async function restoreJson(text: string, lookup: Lookup): Promise<string> {
  const message = JSON.parse(text);
  const walk = async (value: any): Promise<any> => {
    if (typeof value === 'string') return replaceAll(value, lookup, false);
    if (Array.isArray(value)) return Promise.all(value.map(walk));
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) value[key] = await walk(value[key]);
    }
    return value;
  };
  for (const block of message.content ?? []) {
    if (block?.type === 'tool_use') block.input = await walk(block.input);
  }
  return JSON.stringify(message);
}

export function restoreSse(upstream: ReadableStream<Uint8Array>, lookup: Lookup): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      const tools = new Map<number, ToolInputRestorer>();
      const emit = (event: string) => controller.enqueue(encoder.encode(`${event}\n\n`));

      const handle = async (event: string) => {
        const lines = event.split('\n');
        const dataLine = lines.find((line) => line.startsWith('data:'));
        const parsed = dataLine ? parseData(dataLine) : undefined;
        if (!parsed) return emit(event);
        const index = parsed.index;
        const others = lines.filter((line) => !line.startsWith('data:'));
        const withData = (payload: unknown) => [...others, `data: ${JSON.stringify(payload)}`].join('\n');

        if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
          tools.set(index, new ToolInputRestorer(lookup));
          return emit(event);
        }
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta' && tools.has(index)) {
          parsed.delta.partial_json = await tools.get(index)!.push(parsed.delta.partial_json ?? '');
          return emit(withData(parsed));
        }
        if (parsed.type === 'content_block_stop' && tools.has(index)) {
          const rest = await tools.get(index)!.flush();
          tools.delete(index);
          if (rest !== '') {
            emit(`event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index,
              delta: { type: 'input_json_delta', partial_json: rest },
            })}`);
          }
          return emit(event);
        }
        return emit(event);
      };

      const decodeEvents = async (buffer: string, final: boolean): Promise<string> => {
        let rest = buffer;
        let end = rest.indexOf('\n\n');
        while (end !== -1) {
          await handle(rest.slice(0, end));
          rest = rest.slice(end + 2);
          end = rest.indexOf('\n\n');
        }
        if (final && rest !== '') {
          await handle(rest);
          rest = '';
        }
        return rest;
      };

      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer = await decodeEvents(buffer + decoder.decode(value, { stream: true }), false);
        }
        await decodeEvents(buffer + decoder.decode(), true);
      } finally {
        controller.close();
      }
    },
  });
}

function parseData(line: string): any | undefined {
  try {
    return JSON.parse(line.slice(5).trimStart());
  } catch {
    return undefined;
  }
}
