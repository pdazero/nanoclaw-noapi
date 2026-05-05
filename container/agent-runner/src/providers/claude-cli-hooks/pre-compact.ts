#!/usr/bin/env bun
/**
 * PreCompact hook for the claude-cli provider.
 *
 * Mirrors the SDK provider's `createPreCompactHook` (claude.ts) — when
 * Claude Code is about to compact context, archive the pre-compact
 * transcript to `<conversationsDir>/YYYY-MM-DD-<slug>.md` so the
 * conversation isn't lost.
 *
 * Inputs (env):
 *   NANOCLAW_CONVERSATIONS_DIR  — output dir (defaults to /workspace/agent/conversations)
 *   NANOCLAW_ASSISTANT_NAME     — display name for assistant messages
 *
 * Inputs (stdin JSON):
 *   { transcript_path: string, session_id: string }
 */
import fs from 'fs';
import path from 'path';

import { formatTranscriptMarkdown, parseTranscript } from './transcript.js';

const raw = await Bun.stdin.text().catch(() => '');
let event: { transcript_path?: string; session_id?: string } = {};
try {
  event = raw ? JSON.parse(raw) : {};
} catch {
  /* malformed payload → silent no-op */
}

const transcriptPath = event.transcript_path;
if (!transcriptPath || !fs.existsSync(transcriptPath)) {
  process.exit(0);
}

const messages = parseTranscript(fs.readFileSync(transcriptPath, 'utf-8'));
if (messages.length === 0) {
  process.exit(0);
}

let summary: string | undefined;
const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
if (fs.existsSync(indexPath)) {
  try {
    const idx = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
      entries?: Array<{ sessionId: string; summary?: string }>;
    };
    summary = idx.entries?.find((e) => e.sessionId === event.session_id)?.summary;
  } catch {
    /* ignore */
  }
}

const slug = summary
  ? summary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
  : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

const conversationsDir = process.env.NANOCLAW_CONVERSATIONS_DIR || '/workspace/agent/conversations';
fs.mkdirSync(conversationsDir, { recursive: true });

const filename = `${new Date().toISOString().split('T')[0]}-${slug}.md`;
const assistantName = process.env.NANOCLAW_ASSISTANT_NAME || undefined;
fs.writeFileSync(path.join(conversationsDir, filename), formatTranscriptMarkdown(messages, summary, assistantName));

process.exit(0);
