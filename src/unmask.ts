// Restores placeholders in responses, for plain JSON and for streamed events. Tool-use inputs get the
// real value, so the tool can run. Text blocks get a link to the review page, so the user can check
// the value. A placeholder the request did not mask is left unchanged.
const PLACEHOLDER = /⟦SECRET_[0-9a-f]{6,64}⟧/g;
const MAX_HELD = 80;

export type Lookup = (placeholder: string) => Promise<string | undefined>;
export type Restore = { lookup: Lookup; link: Lookup };

type Format = (placeholder: string, resolved: string) => string;

const rawValue: Format = (_placeholder, value) => value;
// Inside a streamed JSON string the value must be escaped to stay valid JSON.
const jsonValue: Format = (_placeholder, value) => JSON.stringify(value).slice(1, -1);
const reviewLink: Format = (placeholder, url) => `[${placeholder}](${url})`;

async function replaceAll(text: string, resolve: Lookup, format: Format): Promise<string> {
  const resolved = new Map<string, string>();
  for (const placeholder of new Set(text.match(PLACEHOLDER) ?? [])) {
    const value = await resolve(placeholder);
    if (value !== undefined) resolved.set(placeholder, value);
  }
  return text.replace(PLACEHOLDER, (placeholder) => {
    const value = resolved.get(placeholder);
    return value === undefined ? placeholder : format(placeholder, value);
  });
}

// Index where an unfinished placeholder starts, or the text length when nothing is pending.
function pendingStart(text: string): number {
  const start = text.lastIndexOf('⟦');
  if (start === -1 || text.indexOf('⟧', start) !== -1 || text.length - start > MAX_HELD) return text.length;
  return start;
}

// Restores placeholders in one streamed block. A placeholder split across fragments is held until complete.
class PlaceholderStream {
  #held = '';
  readonly #resolve: Lookup;
  readonly #format: Format;

  constructor(resolve: Lookup, format: Format) {
    this.#resolve = resolve;
    this.#format = format;
  }

  async push(fragment: string): Promise<string> {
    const text = this.#held + fragment;
    const cut = pendingStart(text);
    this.#held = text.slice(cut);
    return replaceAll(text.slice(0, cut), this.#resolve, this.#format);
  }

  async flush(): Promise<string> {
    const rest = this.#held;
    this.#held = '';
    return replaceAll(rest, this.#resolve, this.#format);
  }
}

export async function restoreJson(text: string, restore: Restore): Promise<string> {
  const message = JSON.parse(text);
  const walk = async (value: any): Promise<any> => {
    if (typeof value === 'string') return replaceAll(value, restore.lookup, rawValue);
    if (Array.isArray(value)) return Promise.all(value.map(walk));
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) value[key] = await walk(value[key]);
    }
    return value;
  };
  for (const block of message.content ?? []) {
    if (block?.type === 'tool_use') block.input = await walk(block.input);
    if (block?.type === 'text' && typeof block.text === 'string') {
      block.text = await replaceAll(block.text, restore.link, reviewLink);
    }
  }
  return JSON.stringify(message);
}

async function restoreResponseItem(item: any, restore: Restore): Promise<void> {
  if (item?.type === 'function_call' && typeof item.arguments === 'string') item.arguments = await replaceAll(item.arguments, restore.lookup, jsonValue);
  if (item?.type === 'custom_tool_call' && typeof item.input === 'string') item.input = await replaceAll(item.input, restore.lookup, rawValue);
  for (const part of item?.content ?? []) if (part.type === 'output_text' && typeof part.text === 'string') {
    part.text = await replaceAll(part.text, restore.link, reviewLink);
  }
}

export async function restoreResponsesJson(text: string, restore: Restore): Promise<string> {
  const response = JSON.parse(text);
  for (const item of response.output ?? []) await restoreResponseItem(item, restore);
  return JSON.stringify(response);
}

export function restoreResponsesSse(upstream: ReadableStream<Uint8Array>, restore: Restore): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const fragments = new Map<string, PlaceholderStream>();
  return new ReadableStream({
    async start(controller) {
      const emit = (event: string) => controller.enqueue(encoder.encode(`${event}\n\n`));
      const handle = async (event: string) => {
        const lines = event.split('\n');
        const data = lines.find(line => line.startsWith('data:'));
        const payload = data ? parseData(data) : undefined;
        if (!payload) return emit(event);
        const type = payload.type;
        const key = `${payload.item_id ?? payload.output_index}:${type?.replace(/\.(delta|done)$/, '')}`;
        if (['response.function_call_arguments.delta', 'response.custom_tool_call_input.delta', 'response.output_text.delta'].includes(type)) {
          if (!fragments.has(key)) fragments.set(key, new PlaceholderStream(
            type === 'response.output_text.delta' ? restore.link : restore.lookup,
            type === 'response.output_text.delta' ? reviewLink : type === 'response.function_call_arguments.delta' ? jsonValue : rawValue));
          payload.delta = await fragments.get(key)!.push(payload.delta ?? '');
        }
        if (type === 'response.function_call_arguments.done') payload.arguments = await replaceAll(payload.arguments, restore.lookup, jsonValue);
        if (type === 'response.custom_tool_call_input.done') payload.input = await replaceAll(payload.input, restore.lookup, rawValue);
        if (type === 'response.output_text.done') payload.text = await replaceAll(payload.text, restore.link, reviewLink);
        if (payload.item) await restoreResponseItem(payload.item, restore);
        if (payload.response) for (const item of payload.response.output ?? []) await restoreResponseItem(item, restore);
        emit([...lines.filter(line => !line.startsWith('data:')), `data: ${JSON.stringify(payload)}`].join('\n'));
      };
      let buffer = '';
      try {
        for await (const chunk of upstream) {
          buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            await handle(buffer.slice(0, end)); buffer = buffer.slice(end + 2);
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) await handle(buffer);
        controller.close();
      } catch (error) { controller.error(error); }
    },
  });
}

export function restoreSse(upstream: ReadableStream<Uint8Array>, restore: Restore): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      const tools = new Map<number, PlaceholderStream>();
      const texts = new Map<number, PlaceholderStream>();
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
          tools.set(index, new PlaceholderStream(restore.lookup, jsonValue));
          return emit(event);
        }
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta' && tools.has(index)) {
          parsed.delta.partial_json = await tools.get(index)!.push(parsed.delta.partial_json ?? '');
          return emit(withData(parsed));
        }
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta' && typeof parsed.delta.text === 'string') {
          if (!texts.has(index)) texts.set(index, new PlaceholderStream(restore.link, reviewLink));
          parsed.delta.text = await texts.get(index)!.push(parsed.delta.text);
          return emit(withData(parsed));
        }
        if (parsed.type === 'content_block_stop') {
          if (tools.has(index)) {
            const rest = await tools.get(index)!.flush();
            tools.delete(index);
            if (rest !== '') {
              emit(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index,
                delta: { type: 'input_json_delta', partial_json: rest },
              })}`);
            }
          }
          if (texts.has(index)) {
            const rest = await texts.get(index)!.flush();
            texts.delete(index);
            if (rest !== '') {
              emit(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index,
                delta: { type: 'text_delta', text: rest },
              })}`);
            }
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
