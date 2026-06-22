import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ToolDefinition } from '../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Telegram — send/receive messages via Telegram Bot API
// ─────────────────────────────────────────────────────────────────────────────

export interface TelegramInput {
  action: 'send' | 'send_photo' | 'send_video' | 'send_document' | 'get_updates' | 'get_chat' | 'set_webhook' | 'info';
  chat_id?: string;
  text?: string;
  photo?: string;      // file path or URL
  video?: string;      // file path, URL, or file_id (for send_video)
  document?: string;   // file path or URL
  caption?: string;
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  reply_to?: number;   // message_id to reply to
  duration?: number;   // video duration in seconds (for send_video)
  width?: number;      // video width (for send_video)
  height?: number;     // video height (for send_video)
  supports_streaming?: boolean; // for send_video
  offset?: number;     // for get_updates — offset from last update
  limit?: number;      // for get_updates — max updates to fetch
  webhook_url?: string;
}

export const TELEGRAM_DEFINITION: ToolDefinition = {
  name: 'telegram',
  description:
    'Communicate via Telegram Bot. Send text messages, photos, videos, documents. Read incoming messages. ' +
    'Configure ~/.aura/telegram.json with { "bot_token": "...", "default_chat_id": "..." }. ' +
    'Create a bot via @BotFather on Telegram.',
  parameters: {
    type: 'object',
    properties: {
      action:       { type: 'string', description: 'Action: send, send_photo, send_video, send_document, get_updates, get_chat, set_webhook, info' },
      chat_id:      { type: 'string', description: 'Chat ID (uses default from config if omitted)' },
      text:         { type: 'string', description: 'Message text (for send)' },
      photo:        { type: 'string', description: 'Photo path or URL (for send_photo)' },
      video:        { type: 'string', description: 'Video URL or file_id (for send_video). Local files not yet supported — use a hosted URL.' },
      document:     { type: 'string', description: 'Document path or URL (for send_document)' },
      caption:      { type: 'string', description: 'Caption for photo/video/document' },
      parse_mode:   { type: 'string', description: 'Parse mode: HTML, Markdown, MarkdownV2' },
      reply_to:     { type: 'number', description: 'Message ID to reply to' },
      duration:     { type: 'number', description: 'Video duration in seconds (for send_video)' },
      width:        { type: 'number', description: 'Video width in pixels (for send_video)' },
      height:       { type: 'number', description: 'Video height in pixels (for send_video)' },
      supports_streaming: { type: 'boolean', description: 'Pass True if the video supports streaming (for send_video)' },
      offset:       { type: 'number', description: 'Update offset for get_updates (to acknowledge processed updates)' },
      limit:        { type: 'number', description: 'Max updates to fetch (default: 10)' },
      webhook_url:  { type: 'string', description: 'Webhook URL for set_webhook' },
    },
    required: ['action'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

interface TelegramConfig {
  bot_token: string;
  default_chat_id?: string;
}

function loadConfig(): TelegramConfig | null {
  const p = path.join(os.homedir(), '.aura', 'telegram.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function saveConfig(config: TelegramConfig): void {
  const dir = path.join(os.homedir(), '.aura');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'telegram.json'), JSON.stringify(config, null, 2), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram API
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = 'https://api.telegram.org';

async function api(token: string, method: string, body?: Record<string, unknown>): Promise<any> {
  const url = `${API_BASE}/bot${token}/${method}`;
  const opts: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  };
  if (body) opts.body = JSON.stringify(body);

  const response = await fetch(url, opts);
  const data = await response.json() as any;

  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description ?? 'Unknown error'} (code: ${data.error_code})`);
  }

  return data.result;
}

async function apiGet(token: string, method: string, params?: Record<string, string>): Promise<any> {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const url = `${API_BASE}/bot${token}/${method}${qs}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const data = await response.json() as any;
  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description ?? 'Unknown error'} (code: ${data.error_code})`);
  }
  return data.result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

async function doSend(config: TelegramConfig, input: TelegramInput): Promise<string> {
  const chatId = input.chat_id ?? config.default_chat_id;
  if (!chatId) return 'Error: chat_id required (or set default_chat_id in config)';
  if (!input.text) return 'Error: text required for send';

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: input.text,
  };
  if (input.parse_mode) body.parse_mode = input.parse_mode;
  if (input.reply_to) body.reply_to_message_id = input.reply_to;

  const result = await api(config.bot_token, 'sendMessage', body);
  return `Message sent to ${chatId} (msg_id: ${result.message_id})`;
}

async function doSendPhoto(config: TelegramConfig, input: TelegramInput): Promise<string> {
  const chatId = input.chat_id ?? config.default_chat_id;
  if (!chatId) return 'Error: chat_id required';
  if (!input.photo) return 'Error: photo required';

  const body: Record<string, unknown> = {
    chat_id: chatId,
    photo: input.photo,
  };
  if (input.caption) body.caption = input.caption;
  if (input.parse_mode) body.parse_mode = input.parse_mode;

  const result = await api(config.bot_token, 'sendPhoto', body);
  return `Photo sent to ${chatId} (msg_id: ${result.message_id})`;
}

async function doSendVideo(config: TelegramConfig, input: TelegramInput): Promise<string> {
  const chatId = input.chat_id ?? config.default_chat_id;
  if (!chatId) return 'Error: chat_id required';
  if (!input.video) return 'Error: video required (URL or file_id)';

  const body: Record<string, unknown> = {
    chat_id: chatId,
    video: input.video,
  };
  if (input.caption) body.caption = input.caption;
  if (input.parse_mode) body.parse_mode = input.parse_mode;
  if (input.duration !== undefined) body.duration = input.duration;
  if (input.width !== undefined) body.width = input.width;
  if (input.height !== undefined) body.height = input.height;
  if (input.supports_streaming !== undefined) body.supports_streaming = input.supports_streaming;
  if (input.reply_to) body.reply_to_message_id = input.reply_to;

  const result = await api(config.bot_token, 'sendVideo', body);
  return `Video sent to ${chatId} (msg_id: ${result.message_id})`;
}

async function doSendDocument(config: TelegramConfig, input: TelegramInput): Promise<string> {
  const chatId = input.chat_id ?? config.default_chat_id;
  if (!chatId) return 'Error: chat_id required';
  if (!input.document) return 'Error: document required';

  const body: Record<string, unknown> = {
    chat_id: chatId,
    document: input.document,
  };
  if (input.caption) body.caption = input.caption;

  const result = await api(config.bot_token, 'sendDocument', body);
  return `Document sent to ${chatId} (msg_id: ${result.message_id})`;
}

async function doGetUpdates(config: TelegramConfig, input: TelegramInput): Promise<string> {
  const params: Record<string, string> = {};
  if (input.offset !== undefined) params.offset = String(input.offset);
  if (input.limit !== undefined) params.limit = String(input.limit);
  else params.limit = '10';

  const updates = await apiGet(config.bot_token, 'getUpdates', params);

  if (updates.length === 0) return 'No new updates.';

  const lines = updates.map((u: any) => {
    const msg = u.message;
    if (!msg) return `[Update ${u.update_id}] (non-message update)`;
    const from = msg.from?.first_name ?? msg.from?.username ?? 'unknown';
    const text = msg.text ?? msg.caption ?? '[media]';
    const date = new Date(msg.date * 1000).toISOString();
    return `[${u.update_id}] ${date} | ${from} (${msg.chat.id}): ${text}`;
  });

  const lastOffset = updates[updates.length - 1].update_id + 1;
  return `Updates (${updates.length}):\n${lines.join('\n')}\n\nNext offset: ${lastOffset}`;
}

async function doGetChat(config: TelegramConfig, input: TelegramInput): Promise<string> {
  const chatId = input.chat_id ?? config.default_chat_id;
  if (!chatId) return 'Error: chat_id required';

  const chat = await apiGet(config.bot_token, 'getChat', { chat_id: chatId });
  return `Chat info:\nID: ${chat.id}\nType: ${chat.type}\nTitle: ${chat.title ?? chat.first_name ?? 'N/A'}`;
}

async function doSetWebhook(config: TelegramConfig, input: TelegramInput): Promise<string> {
  if (!input.webhook_url) return 'Error: webhook_url required';

  await api(config.bot_token, 'setWebhook', { url: input.webhook_url });
  return `Webhook set to: ${input.webhook_url}`;
}

async function doGetInfo(config: TelegramConfig): Promise<string> {
  const me = await apiGet(config.bot_token, 'getMe');
  return `Bot info:\nID: ${me.id}\nName: ${me.first_name}\nUsername: @${me.username}\nCan join groups: ${me.can_join_groups}\nCan read messages: ${me.can_read_all_group_messages}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main executor
// ─────────────────────────────────────────────────────────────────────────────

export async function telegramTool(input: TelegramInput): Promise<string> {
  const config = loadConfig();
  if (!config) {
    return 'Error: Telegram not configured. Create ~/.aura/telegram.json with { "bot_token": "YOUR_TOKEN", "default_chat_id": "YOUR_CHAT_ID" }. Get a bot token from @BotFather.';
  }

  try {
    switch (input.action) {
      case 'send':           return await doSend(config, input);
      case 'send_photo':     return await doSendPhoto(config, input);
      case 'send_video':     return await doSendVideo(config, input);
      case 'send_document':  return await doSendDocument(config, input);
      case 'get_updates':    return await doGetUpdates(config, input);
      case 'get_chat':       return await doGetChat(config, input);
      case 'set_webhook':    return await doSetWebhook(config, input);
      case 'info':           return await doGetInfo(config);
      default:               return `Error: Unknown telegram action: ${input.action}`;
    }
  } catch (e: any) {
    return `Telegram error (${input.action}): ${e?.message ?? String(e)}`;
  }
}
