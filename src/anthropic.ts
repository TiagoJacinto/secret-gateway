// Anthropic Messages adapter: walks a request into text slots and appends the prompt note.
// Images pass through unchanged. The masking core only sees slots, so another provider's message
// format needs only a new adapter.

export const WITHHELD_BLOCK = '[content withheld by secret-gateway: this block type cannot be scanned, so it was not sent]';

export const PROMPT_NOTE = [
  'Secret masking is active. Values that look like credentials appear as placeholders in the form ⟦SECRET_xxxxxx⟧.',
  'A placeholder stands in for a real value. The gateway restores the real value in tool inputs when the tool runs.',
  'Use each placeholder exactly as written in commands and tool arguments. Do not treat a placeholder as missing, broken or unknown,',
  'and do not warn about it or ask the user to supply the value.',
  'When a value is only visible in a screenshot, prefer the dashboard\'s Copy button and paste the value over retyping what you read.',
  'After using a placeholder, check the result so that a wrong value fails loudly.',
  'Prefer text sources, such as the accessibility tree, over screenshots when both show the same information.',
  'Do not delete, rotate or revoke a credential without the user\'s explicit approval. Report where it is instead.',
].join(' ');

export type TextSlot = {
  kind: 'text';
  text: string;
  source: string;
  gitContext: boolean;
  write(value: string): void;
};

type Block = Record<string, any>;

function withhold(container: unknown[], index: number): void {
  container[index] = { type: 'text', text: WITHHELD_BLOCK };
}

// Strings at any depth of a tool input. They can hold values copied from earlier results.
function collectLeaves(container: Block, key: string, add: (slot: TextSlot) => void, source: string, gitContext: boolean): void {
  const current = container[key];
  if (typeof current === 'string') {
    add({ kind: 'text', text: current, source, gitContext, write: (next) => { container[key] = next; } });
  } else if (current && typeof current === 'object') {
    for (const childKey of Object.keys(current)) collectLeaves(current, childKey, add, source, gitContext);
  }
}

export function collectSlots(body: Block): TextSlot[] {
  const slots: TextSlot[] = [];
  const add = (slot: TextSlot) => slots.push(slot);

  if (typeof body.system === 'string') {
    add({ kind: 'text', text: body.system, source: 'system prompt', gitContext: false, write: (v) => { body.system = v; } });
  } else if (Array.isArray(body.system)) {
    body.system.forEach((block: Block) => {
      if (block?.type === 'text') add({ kind: 'text', text: block.text, source: 'system prompt', gitContext: false, write: (v) => { block.text = v; } });
    });
  }

  const messages: Block[] = Array.isArray(body.messages) ? body.messages : [];
  const toolNames = new Map<string, string>();
  const toolGit = new Map<string, boolean>();
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type === 'tool_use' || block?.type === 'server_tool_use') {
        toolNames.set(block.id, String(block.name));
        toolGit.set(block.id, /\bgit\b/.test(JSON.stringify(block.input ?? {})));
      }
    }
  }

  for (const message of messages) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    if (typeof message?.content === 'string') {
      const holder = message;
      add({ kind: 'text', text: message.content, source: `${role} message`, gitContext: false, write: (v) => { holder.content = v; } });
      continue;
    }
    if (!Array.isArray(message?.content)) continue;
    const content: unknown[] = message.content;
    content.forEach((block: Block, index) => {
      switch (block?.type) {
        case 'text':
          add({ kind: 'text', text: block.text, source: `${role} message text`, gitContext: false, write: (v) => { block.text = v; } });
          return;
        case 'tool_use':
        case 'server_tool_use': {
          if (!block.input || typeof block.input !== 'object') return;
          const source = `tool input for ${String(block.name)}`;
          for (const key of Object.keys(block.input)) {
            collectLeaves(block.input, key, add, source, toolGit.get(block.id) ?? false);
          }
          return;
        }
        case 'tool_result': {
          const source = `tool result from ${toolNames.get(block.tool_use_id) ?? 'unknown tool'}`;
          const gitContext = toolGit.get(block.tool_use_id) ?? false;
          if (typeof block.content === 'string') {
            add({ kind: 'text', text: block.content, source, gitContext, write: (v) => { block.content = v; } });
          } else if (Array.isArray(block.content)) {
            block.content.forEach((inner: Block, innerIndex: number) => {
              if (inner?.type === 'text') {
                add({ kind: 'text', text: inner.text, source, gitContext, write: (v) => { inner.text = v; } });
              } else if (!(inner?.type === 'image' && inner.source?.type === 'base64')) {
                withhold(block.content, innerIndex);
              }
            });
          }
          return;
        }
        case 'image':
          if (block.source?.type !== 'base64') withhold(content, index);
          return;
        case 'thinking':
        case 'redacted_thinking':
          return;
        default:
          withhold(content, index);
      }
    });
  }
  return slots;
}

export function addPromptNote(body: Block): void {
  if (typeof body.system === 'string') {
    body.system = [{ type: 'text', text: body.system }, { type: 'text', text: PROMPT_NOTE }];
  } else if (Array.isArray(body.system)) {
    body.system.push({ type: 'text', text: PROMPT_NOTE });
  } else {
    body.system = [{ type: 'text', text: PROMPT_NOTE }];
  }
}
