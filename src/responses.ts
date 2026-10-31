// Responses request adapter. Protocol identifiers and encrypted reasoning remain opaque.
import { createHash } from 'node:crypto';
import { PROMPT_NOTE, WITHHELD_BLOCK, type TextSlot } from './anthropic.ts';

export function collectResponseSlots(body: Record<string, any>): TextSlot[] {
  const slots: TextSlot[] = [];
  let order = 0;
  const add = (holder: any, key: string, source: string) => {
    if (typeof holder[key] !== 'string') return;
    slots.push({ kind: 'text', text: holder[key], source, location: `${source}, item ${order}`,
      order, gitContext: false, write: value => { holder[key] = value; } });
  };
  add(body, 'instructions', 'instructions');
  const content = (holder: any, key: string) => {
    if (typeof holder[key] === 'string') return add(holder, key, 'message text');
    if (!Array.isArray(holder[key])) throw new Error('unsupported content');
    holder[key].forEach((part: any, index: number) => {
      if (['input_text', 'output_text', 'text'].includes(part?.type)) add(part, 'text', 'message text');
      else if (part?.type === 'input_image' && typeof part.image_url === 'string' && part.image_url.startsWith('data:image/')) return;
      else holder[key][index] = { type: 'input_text', text: WITHHELD_BLOCK };
    });
  };
  if (typeof body.input === 'string') add(body, 'input', 'user message');
  else if (Array.isArray(body.input)) body.input.forEach((item: any, index: number) => {
    order = index + 1;
    switch (item?.type) {
      case undefined:
      case 'message': content(item, 'content'); break;
      case 'function_call': add(item, 'arguments', 'function arguments'); break;
      case 'custom_tool_call': add(item, 'input', 'custom tool input'); break;
      case 'function_call_output':
      case 'custom_tool_call_output': content(item, 'output'); break;
      case 'reasoning':
        if (Array.isArray(item.summary)) item.summary.forEach((part: any) => add(part, 'text', 'reasoning summary'));
        break;
      case 'compaction': break;
      case 'additional_tools': Object.keys(item).forEach(key => walk(item, key)); break;
      default: throw new Error('unsupported Responses input item');
    }
  });
  else throw new Error('unsupported Responses input');
  // Also scan auxiliary strings, including tool descriptions and request metadata.
  function walk(holder: any, key: string) {
    if (['id', 'type', 'name', 'call_id'].includes(key)) return;
    if (typeof holder[key] === 'string') add(holder, key, 'request metadata');
    else if (holder[key] && typeof holder[key] === 'object') Object.keys(holder[key]).forEach(child => walk(holder[key], child));
  }
  for (const key of ['tools', 'metadata', 'prompt']) if (body[key]) walk(body, key);
  return slots;
}

export function responseConversation(headers: Headers, body: Record<string, any>) {
  const instructions = createHash('sha256').update(JSON.stringify(body.instructions ?? '')).digest('hex');
  return { key: `responses:${headers.get('session_id') ?? headers.get('x-codex-session-id') ?? ''}:${instructions}`,
    count: Array.isArray(body.input) ? body.input.length : 1 };
}

export function addResponseNote(body: Record<string, any>): void {
  body.instructions = `${body.instructions ?? ''}\n${PROMPT_NOTE}`;
}
