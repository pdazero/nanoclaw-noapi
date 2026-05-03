import { describe, expect, it } from 'bun:test';

import { formatTranscriptMarkdown, parseTranscript } from './transcript.js';

describe('parseTranscript', () => {
  it('extracts user + assistant messages from JSONL', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', message: { content: 'Hi' } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello back' }] },
      }),
    ].join('\n');

    expect(parseTranscript(jsonl)).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello back' },
    ]);
  });

  it('handles assistant content arrays with mixed parts (keeps text only)', () => {
    const jsonl = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Pre.' },
          { type: 'tool_use', id: 'x', name: 'Bash', input: {} },
          { type: 'text', text: 'Post.' },
        ],
      },
    });
    expect(parseTranscript(jsonl)).toEqual([{ role: 'assistant', content: 'Pre.Post.' }]);
  });

  it('skips unparseable lines silently', () => {
    expect(parseTranscript('not json\n{"type":"user","message":{"content":"OK"}}')).toEqual([
      { role: 'user', content: 'OK' },
    ]);
  });

  it('skips entries with no content', () => {
    const jsonl = JSON.stringify({ type: 'user', message: { content: '' } });
    expect(parseTranscript(jsonl)).toEqual([]);
  });
});

describe('formatTranscriptMarkdown', () => {
  it('renders a title block + role-tagged messages', () => {
    const md = formatTranscriptMarkdown(
      [
        { role: 'user', content: 'Q?' },
        { role: 'assistant', content: 'A.' },
      ],
      'My session',
      'Nano',
    );
    expect(md).toContain('# My session');
    expect(md).toContain('**User**: Q?');
    expect(md).toContain('**Nano**: A.');
    expect(md).toContain('Archived: ');
  });

  it('truncates messages longer than 2000 chars', () => {
    const long = 'x'.repeat(2500);
    const md = formatTranscriptMarkdown([{ role: 'user', content: long }]);
    expect(md).toContain('xxx...');
    expect(md.length).toBeLessThan(2300);
  });

  it("falls back to 'Conversation' / 'Assistant' when title and assistantName are missing", () => {
    const md = formatTranscriptMarkdown([{ role: 'assistant', content: 'Yo' }]);
    expect(md).toContain('# Conversation');
    expect(md).toContain('**Assistant**: Yo');
  });
});
