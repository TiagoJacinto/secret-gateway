// Anthropic Messages adapter: walks a request into text slots and appends the prompt note.
// Images pass through unchanged. The masking core only sees slots, so another provider's message
// format needs only a new adapter.
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const WITHHELD_BLOCK = '[content withheld by secret-gateway: this block type cannot be scanned, so it was not sent]';

const DETECT_CLI = join(import.meta.dir, 'detect-cli.ts');

// Single-quotes a path for a POSIX shell.
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

// The note the gateway appends to every model request. It names the detection command for this gateway's
// data directory, so an agent working in another directory edits the file this gateway reads.
export function promptNote(dataDir: string): string {
  const detect = `GATEWAY_DATA_DIR=${shellQuote(dataDir)} bun ${shellQuote(DETECT_CLI)}`;
  return [
    'Secret masking is active. Values that look like credentials appear as placeholders in the form ⟦SECRET_xxxxxx⟧.',
    'A placeholder stands in for a real value. The gateway restores the real value in tool inputs when the tool runs.',
    'Copy each placeholder exactly as written from text you received into commands and tool arguments.',
    'Treat it as the real value: use it directly, and handle the task without asking the user for the value.',
    'Give files, directories and other things you name plain names. A placeholder holds a value only when it appears in text you received,',
    'so the gateway withholds a tool call that uses any other placeholder.',
    'Masking covers all text you receive, including command output, files and accessibility trees, so reading a credential as text shows you only its placeholder.',
    'Handle the credentials a task needs yourself. To move a value shown in a dashboard, read it from the accessibility tree',
    'and pass its placeholder to a command that keeps it out of the output, such as printf \'%s\' ⟦SECRET_xxxxxx⟧ | gh secret set NAME.',
    'After using a placeholder, check the result so that a wrong value fails loudly.',
    'Screenshots, including those attached to other tool results, are not masked. Prefer text sources, such as the accessibility tree,',
    'over screenshots, and take a screenshot only when no credential value is on screen.',
    'If you see a credential in plain text instead of a placeholder, the gateway missed it and the value has already reached the model provider.',
    'First note how to identify it: its prefix, its last 4 characters and where it appeared, such as acme_…d795 in the output of a command.',
    'Once the value is masked you can no longer read it, and dashboards list credentials by these characters.',
    `Then add a detection pattern, so that the next request masks it: ${detect} add pattern '<regex>' --case sensitive --note '<what it is>'.`,
    'Write the pattern for the credential\'s format, such as its prefix, alphabet and length, never the value itself.',
    'Use --case insensitive only when the format allows any capitalization.',
    'Then check that the value now appears as a placeholder.',
    'Then tell the user where the credential is, that it reached the model provider, and the characters you noted.',
    'You may revoke or rotate a credential you created in this conversation without asking. Match it by the characters you noted.',
    'If something uses it, such as a CI secret, store a replacement there first, then revoke the old one.',
    'Do not delete, rotate or revoke any other credential without the user\'s explicit approval. Recommend revoking it and report where it is instead.',
  ].join(' ');
}

export type TextSlot = {
  kind: 'text';
  text: string;
  source: string;
  // Where the text sits in the session, such as "user message text, message 3".
  location: string;
  // 0 for the system prompt, otherwise the message number (1 for the first message).
  order: number;
  gitContext: boolean;
  write(value: string): void;
};

type SlotInput = Omit<TextSlot, 'location' | 'order'>;

type Block = Record<string, any>;

function withhold(container: unknown[], index: number): void {
  container[index] = { type: 'text', text: WITHHELD_BLOCK };
}

// Strings at any depth of a tool input. They can hold values copied from earlier results.
function collectLeaves(container: Block, key: string, add: (slot: SlotInput) => void, source: string, gitContext: boolean): void {
  const current = container[key];
  if (typeof current === 'string') {
    add({ kind: 'text', text: current, source, gitContext, write: (next) => { container[key] = next; } });
  } else if (current && typeof current === 'object') {
    for (const childKey of Object.keys(current)) collectLeaves(current, childKey, add, source, gitContext);
  }
}

export function collectSlots(body: Block): TextSlot[] {
  const slots: TextSlot[] = [];
  // Position in the session of the message being walked. System prompt text has none.
  let position: string | undefined;
  let order = 0;
  const add = (slot: SlotInput) => slots.push({ ...slot, location: position ? `${slot.source}, ${position}` : slot.source, order });

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

  for (const [index, message] of messages.entries()) {
    position = `message ${index + 1}`;
    order = index + 1;
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    if (typeof message?.content === 'string') {
      const holder = message;
      add({ kind: 'text', text: message.content, source: `${role} message`, gitContext: false, write: (v) => { holder.content = v; } });
      continue;
    }
    if (!Array.isArray(message?.content)) continue;
    const content: Block[] = message.content;
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
              } else if (inner?.type === 'tool_reference' && typeof inner.tool_name === 'string'
                && Object.keys(inner).length === 2) {
                add({ kind: 'text', text: inner.tool_name, source: `${source} tool reference`, gitContext: false,
                  write: (v) => { inner.tool_name = v; } });
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

// Conversation of a request: a key from the Claude Code session header and a digest of the system prompt,
// and the message count. Side requests of one session, which carry their own system prompt, get their own key.
export function conversationOf(headers: Headers, body: Block): { key: string; count: number } {
  const system = createHash('sha256').update(JSON.stringify(body.system ?? null)).digest('hex');
  const count = Array.isArray(body.messages) ? body.messages.length : 0;
  return { key: `${headers.get('x-claude-code-session-id') ?? ''}:${system}`, count };
}

export function addPromptNote(body: Block, note: string): void {
  if (typeof body.system === 'string') {
    body.system = [{ type: 'text', text: body.system }, { type: 'text', text: note }];
  } else if (Array.isArray(body.system)) {
    body.system.push({ type: 'text', text: note });
  } else {
    body.system = [{ type: 'text', text: note }];
  }
}
