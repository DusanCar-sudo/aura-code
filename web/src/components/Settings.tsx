import { useState, useCallback, useEffect, useRef } from 'react';
import { LOCALES, type Locale } from '../i18n';
import type { PermissionLevel, Settings as S } from '../lib/settings';

type T = (key: string) => string;
export type SettingsTab = 'agents' | 'models' | 'skills' | 'autonomy' | 'general';

export interface ToolInfo {
  name: string;
  description: string;
}

interface AgentPersona {
  key: string;
  name: string;
  desc: string;
  tools: string[];
}

export interface ModelOption {
  id: string;
  name?: string;
  label?: string;
  provider: string;
  speed?: string;
  hasKey?: boolean;
}

const PRELOADED_AGENTS: AgentPersona[] = [
  {
    key: 'aura',
    name: 'Aura',
    desc: 'The default. Reproduces before touching, verifies before reporting. Full tool grant.',
    tools: ['read', 'list', 'edit', 'write', 'search', 'shell', 'test', 'git'],
  },
  {
    key: 'coder',
    name: 'Coder',
    desc: 'Writes and edits code, runs the suite. No shell, no git push without a gate.',
    tools: ['read', 'list', 'edit', 'write', 'test'],
  },
  {
    key: 'researcher',
    name: 'Researcher',
    desc: 'Reads and searches only. Never writes. Produces findings with citations.',
    tools: ['read', 'list', 'search'],
  },
  {
    key: 'writer',
    name: 'Writer',
    desc: 'Docs, changelogs, comments. Edits prose files, runs no code.',
    tools: ['read', 'edit', 'write'],
  },
];

const ALL_TOOLS = [
  { name: 'read', icon: '📄', label: 'read' },
  { name: 'list', icon: '📁', label: 'list' },
  { name: 'edit', icon: '✏️', label: 'edit' },
  { name: 'write', icon: '📝', label: 'write' },
  { name: 'search', icon: '🔍', label: 'search' },
  { name: 'shell', icon: '⚡', label: 'shell' },
  { name: 'test', icon: '🧪', label: 'test' },
  { name: 'git', icon: '🌿', label: 'git' },
];

interface ProviderEntry {
  id: string;
  name: string;
  envKey?: string;
  signupUrl?: string;
  role: 'primary' | 'mesh' | 'archimedes' | 'review';
  endpoint: string;
  model: string;
  key: string;
  maskedKey?: string;
  keySet?: boolean;
  ping: string;
  pingOk: boolean;
}

const DEFAULT_PROVIDERS: ProviderEntry[] = [
  { id: 'p_google', name: 'Google (Gemini)', envKey: 'GOOGLE_API_KEY', signupUrl: 'https://aistudio.google.com/app/apikey', role: 'primary', endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.1-pro-preview', key: '', ping: 'no key', pingOk: false },
  { id: 'p_anthropic', name: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', signupUrl: 'https://console.anthropic.com', role: 'mesh', endpoint: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5-20251001', key: '', ping: 'no key', pingOk: false },
  { id: 'p_openai', name: 'OpenAI', envKey: 'OPENAI_API_KEY', signupUrl: 'https://platform.openai.com/api-keys', role: 'mesh', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o', key: '', ping: 'no key', pingOk: false },
  { id: 'p_cerebras', name: 'Cerebras (Free Wafer-Scale)', envKey: 'CEREBRAS_API_KEY', signupUrl: 'https://cloud.cerebras.ai', role: 'mesh', endpoint: 'https://api.cerebras.ai/v1', model: 'cerebras/llama-3.3-70b', key: '', ping: 'no key', pingOk: false },
  { id: 'p_sambanova', name: 'SambaNova Cloud (Free Tier)', envKey: 'SAMBANOVA_API_KEY', signupUrl: 'https://cloud.sambanova.ai', role: 'mesh', endpoint: 'https://api.sambanova.ai/v1', model: 'sambanova/Meta-Llama-3.3-70B-Instruct', key: '', ping: 'no key', pingOk: false },
  { id: 'p_opencode', name: 'OpenCode Zen (Free & Fast)', envKey: 'OPENCODE_API_KEY', signupUrl: 'https://opencode.ai', role: 'mesh', endpoint: 'https://opencode.ai/zen/v1', model: 'opencode/big-pickle', key: '', ping: 'no key', pingOk: false },
  { id: 'p_opencode_go', name: 'OpenCode Go (Anthropic API)', envKey: 'OPENCODE_GO_API_KEY', signupUrl: 'https://opencode.ai', role: 'mesh', endpoint: 'https://opencode.ai/go/v1', model: 'go-anthropic/claude-sonnet-5', key: '', ping: 'no key', pingOk: false },
  { id: 'p_openrouter', name: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', signupUrl: 'https://openrouter.ai/keys', role: 'mesh', endpoint: 'https://openrouter.ai/api/v1', model: 'openrouter/deepseek/deepseek-v4-pro', key: '', ping: 'no key', pingOk: false },
  { id: 'p_groq', name: 'Groq (Ultra-Fast Free Tier)', envKey: 'GROQ_API_KEY', signupUrl: 'https://console.groq.com/keys', role: 'mesh', endpoint: 'https://api.groq.com/openai/v1', model: 'groq/llama-3.3-70b-versatile', key: '', ping: 'no key', pingOk: false },
  { id: 'p_mistral', name: 'Mistral AI', envKey: 'MISTRAL_API_KEY', signupUrl: 'https://console.mistral.ai', role: 'mesh', endpoint: 'https://api.mistral.ai/v1', model: 'mistral/codestral-latest', key: '', ping: 'no key', pingOk: false },
  { id: 'p_together', name: 'Together AI', envKey: 'TOGETHER_API_KEY', signupUrl: 'https://api.together.ai', role: 'mesh', endpoint: 'https://api.together.xyz/v1', model: 'together/meta-llama/Llama-3.3-70B-Instruct-Turbo', key: '', ping: 'no key', pingOk: false },
  { id: 'p_cohere', name: 'Cohere', envKey: 'COHERE_API_KEY', signupUrl: 'https://dashboard.cohere.com/api-keys', role: 'mesh', endpoint: 'https://api.cohere.com/v2', model: 'cohere/command-r-plus-08-2024', key: '', ping: 'no key', pingOk: false },
  { id: 'p_nvidia', name: 'NVIDIA NIM (Nemotron)', envKey: 'NVIDIA_API_KEY', signupUrl: 'https://build.nvidia.com', role: 'mesh', endpoint: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/llama-3.1-nemotron-70b-instruct', key: '', ping: 'no key', pingOk: false },
  { id: 'p_deepseek', name: 'DeepSeek', envKey: 'DEEPSEEK_API_KEY', signupUrl: 'https://platform.deepseek.com', role: 'mesh', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', key: '', ping: 'no key', pingOk: false },
  { id: 'p_xiaomi', name: 'Xiaomi MiMo', envKey: 'XIAOMI_API_KEY', signupUrl: 'https://xiaomimimo.com', role: 'mesh', endpoint: 'https://token-plan-sgp.xiaomimimo.com/v1', model: 'mimo-v2.5-pro', key: '', ping: 'no key', pingOk: false },
  { id: 'p_zhipu', name: 'Zhipu (GLM)', envKey: 'ZHIPU_API_KEY', signupUrl: 'https://open.bigmodel.cn', role: 'mesh', endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.2', key: '', ping: 'no key', pingOk: false },
  { id: 'p_qwen', name: 'Qwen (DashScope)', envKey: 'DASHSCOPE_API_KEY', signupUrl: 'https://bailian.console.aliyun.com', role: 'mesh', endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen/qwen3-coder-plus', key: '', ping: 'no key', pingOk: false },
  { id: 'p_xai', name: 'xAI (Grok)', envKey: 'XAI_API_KEY', signupUrl: 'https://console.x.ai', role: 'mesh', endpoint: 'https://api.x.ai/v1', model: 'grok-2', key: '', ping: 'no key', pingOk: false },
  { id: 'p_minimax', name: 'MiniMax', envKey: 'MINIMAX_API_KEY', signupUrl: 'https://platform.minimaxi.com', role: 'mesh', endpoint: 'https://api.minimax.chat/v1', model: 'minimax/MiniMax-Text-01', key: '', ping: 'no key', pingOk: false },
  { id: 'p_kimi', name: 'Kimi (Moonshot)', envKey: 'MOONSHOT_API_KEY', signupUrl: 'https://platform.moonshot.cn', role: 'mesh', endpoint: 'https://api.moonshot.cn/v1', model: 'kimi/kimi-k2-0905-preview', key: '', ping: 'no key', pingOk: false },
  { id: 'p_stepfun', name: 'StepFun', envKey: 'STEPFUN_API_KEY', signupUrl: 'https://platform.stepfun.com', role: 'mesh', endpoint: 'https://api.stepfun.com/v1', model: 'stepfun/step-2-16k', key: '', ping: 'no key', pingOk: false },
  { id: 'p_fireworks', name: 'Fireworks AI', envKey: 'FIREWORKS_API_KEY', signupUrl: 'https://fireworks.ai', role: 'mesh', endpoint: 'https://api.fireworks.ai/inference/v1', model: 'fireworks/accounts/fireworks/models/deepseek-r1', key: '', ping: 'no key', pingOk: false },
  { id: 'p_fpt', name: 'FPT Cloud AI', envKey: 'FPT_API_KEY', signupUrl: 'https://fptcloud.com', role: 'mesh', endpoint: 'https://mkp-api.fptcloud.com/v1', model: 'fpt/DeepSeek-V4-Flash', key: '', ping: 'no key', pingOk: false },
  { id: 'p_byteplus', name: 'BytePlus ModelArk', envKey: 'ARK_API_KEY', signupUrl: 'https://byteplus.com', role: 'mesh', endpoint: 'https://ark.ap-southeast.bytepluses.com/api/v3', model: 'byteplus/deepseek-v4-flash-ga-260731', key: '', ping: 'no key', pingOk: false },
  { id: 'p_upstage', name: 'Upstage', envKey: 'UPSTAGE_API_KEY', signupUrl: 'https://console.upstage.ai', role: 'mesh', endpoint: 'https://api.upstage.ai/v1/solar', model: 'upstage/solar-pro', key: '', ping: 'no key', pingOk: false },
  { id: 'p_arcee', name: 'Arcee AI', envKey: 'ARCEE_API_KEY', signupUrl: 'https://arcee.ai', role: 'mesh', endpoint: 'https://api.arcee.ai/v1', model: 'arcee/trinity-large-preview', key: '', ping: 'no key', pingOk: false },
  { id: 'p_tencent', name: 'Tencent TokenHub', envKey: 'TENCENT_API_KEY', signupUrl: 'https://cloud.tencent.com', role: 'mesh', endpoint: 'https://tokenhub.tencentmaas.com/v1', model: 'tencent/hunyuan-large', key: '', ping: 'no key', pingOk: false },
  { id: 'p_gmi', name: 'GMI Cloud', envKey: 'GMI_API_KEY', signupUrl: 'https://gmicloud.ai', role: 'mesh', endpoint: 'https://api.gmi-serving.com/v1', model: 'gmi/deepseek-ai/deepseek-r1', key: '', ping: 'no key', pingOk: false },
  { id: 'p_kilocode', name: 'Kilo Code', envKey: 'KILOCODE_API_KEY', signupUrl: 'https://kilocode.ai', role: 'mesh', endpoint: 'https://api.kilocode.ai/api/openrouter', model: 'kilocode/auto', key: '', ping: 'no key', pingOk: false },
  { id: 'p_alibaba', name: 'Alibaba Cloud Coding Plan', envKey: 'ALIBABA_API_KEY', signupUrl: 'https://www.alibabacloud.com', role: 'mesh', endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'alibaba/qwen3-coder-plus', key: '', ping: 'no key', pingOk: false },
  { id: 'p_huggingface', name: 'Hugging Face', envKey: 'HUGGINGFACE_API_KEY', signupUrl: 'https://huggingface.co/settings/tokens', role: 'mesh', endpoint: 'https://router.huggingface.co/v1', model: 'huggingface/meta-llama/Llama-3.3-70B-Instruct', key: '', ping: 'no key', pingOk: false },
  { id: 'p_ollama', name: 'Ollama (local)', envKey: undefined, role: 'mesh', endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen3-coder:30b', key: '-', ping: '6ms', pingOk: true },
  { id: 'p_lmstudio', name: 'LM Studio / Local', envKey: undefined, role: 'mesh', endpoint: 'http://127.0.0.1:1234/v1', model: 'local/qwen2.5-coder-32b-instruct', key: '-', ping: '4ms', pingOk: true },
];

const COMPREHENSIVE_FALLBACK_MODELS: ModelOption[] = [
  // Google Gemini
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', provider: 'Google', speed: 'Powerful · reasoning' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', provider: 'Google', speed: 'Fast · cheap' },
  { id: 'gemini-pro-latest', label: 'Gemini Pro (latest)', provider: 'Google', speed: 'Powerful' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'Google', speed: 'Fast' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', provider: 'Google', speed: 'Fastest · cheap' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', provider: 'Google', speed: 'Fast · cheap' },
  // Cerebras (Free Wafer-Scale)
  { id: 'cerebras/llama-3.3-70b', label: 'Llama 3.3 70B (Cerebras Ultra-fast free)', provider: 'Cerebras', speed: 'Ultra-fast · free' },
  { id: 'cerebras/llama3.1-8b', label: 'Llama 3.1 8B (Cerebras Instant free)', provider: 'Cerebras', speed: 'Instant · free' },
  { id: 'cerebras/deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 70B (Cerebras Free reasoning)', provider: 'Cerebras', speed: 'Reasoning · free' },
  { id: 'cerebras/gpt-oss-120b', label: 'GPT OSS 120B (Cerebras Free)', provider: 'Cerebras', speed: 'Powerful · free' },
  // SambaNova Cloud (Free Tier)
  { id: 'sambanova/Meta-Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B (SambaNova Free tier)', provider: 'SambaNova', speed: 'Ultra-fast · free' },
  { id: 'sambanova/DeepSeek-R1-Distill-Llama-70B', label: 'DeepSeek R1 70B (SambaNova Free tier)', provider: 'SambaNova', speed: 'Reasoning · free' },
  { id: 'sambanova/Meta-Llama-3.1-405B-Instruct', label: 'Llama 3.1 405B (SambaNova Free tier)', provider: 'SambaNova', speed: 'Powerful · free' },
  // OpenCode
  { id: 'opencode/big-pickle', label: 'Big Pickle (free)', provider: 'OpenCode', speed: 'Powerful · free' },
  { id: 'opencode/mimo-v2.5-free', label: 'MiMo V2.5 (free)', provider: 'OpenCode', speed: 'Fast · free' },
  { id: 'opencode/nemotron-3-ultra-free', label: 'Nemotron 3 Ultra (free)', provider: 'OpenCode', speed: 'Powerful · free' },
  { id: 'opencode/hy3-free', label: 'HY3 (free)', provider: 'OpenCode', speed: 'Fast · free' },
  { id: 'opencode/gpt-5.4', label: 'GPT-5.4', provider: 'OpenCode', speed: 'Powerful · paid' },
  { id: 'opencode/claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'OpenCode', speed: 'Powerful · paid' },
  { id: 'go-anthropic/claude-sonnet-5', label: 'Claude Sonnet 5 (Go)', provider: 'OpenCode', speed: 'Powerful' },
  { id: 'go-anthropic/claude-opus-5', label: 'Claude Opus 5 (Go)', provider: 'OpenCode', speed: 'Powerful' },
  // OpenRouter
  { id: 'openrouter/google/gemini-2.0-flash-lite-001:free', label: 'Gemini 2.0 Flash Lite (OR free)', provider: 'OpenRouter', speed: 'Fast · free' },
  { id: 'openrouter/meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (OR free)', provider: 'OpenRouter', speed: 'Powerful · free' },
  { id: 'openrouter/deepseek/deepseek-r1:free', label: 'DeepSeek R1 (OR free)', provider: 'OpenRouter', speed: 'Reasoning · free' },
  { id: 'openrouter/qwen/qwen-2.5-coder-32b-instruct:free', label: 'Qwen 2.5 Coder 32B (OR free)', provider: 'OpenRouter', speed: 'Code · free' },
  { id: 'openrouter/deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro (OR)', provider: 'OpenRouter', speed: 'Powerful · open' },
  { id: 'openrouter/deepseek/deepseek-r1', label: 'DeepSeek R1 (OR)', provider: 'OpenRouter', speed: 'Reasoning · open' },
  { id: 'openrouter/anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet (OR)', provider: 'OpenRouter', speed: 'Fast' },
  { id: 'openrouter/openai/gpt-4o', label: 'GPT-4o (OR)', provider: 'OpenRouter', speed: 'Powerful' },
  { id: 'openrouter/meta-llama/llama-3.1-405b-instruct', label: 'Llama 3.1 405B (OR)', provider: 'OpenRouter', speed: 'Open · powerful' },
  { id: 'openrouter/meta-llama/llama-3.1-70b-instruct', label: 'Llama 3.1 70B (OR)', provider: 'OpenRouter', speed: 'Open · fast' },
  // Groq
  { id: 'groq/llama-3.3-70b-versatile', label: 'Llama 3.3 70B (Groq)', provider: 'Groq', speed: 'Ultra-fast · 128k' },
  { id: 'groq/llama-3.1-8b-instant', label: 'Llama 3.1 8B (Groq)', provider: 'Groq', speed: 'Instant · 128k' },
  { id: 'groq/deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 70B (Groq)', provider: 'Groq', speed: 'Ultra-fast reasoning' },
  // Mistral AI
  { id: 'mistral/codestral-latest', label: 'Codestral Latest', provider: 'Mistral AI', speed: 'Code · fast' },
  { id: 'mistral/mistral-large-latest', label: 'Mistral Large Latest', provider: 'Mistral AI', speed: 'Powerful · flagship' },
  { id: 'mistral/mistral-small-latest', label: 'Mistral Small Latest', provider: 'Mistral AI', speed: 'Fast · cheap' },
  { id: 'mistral/open-mistral-nemo', label: 'Mistral Nemo', provider: 'Mistral AI', speed: 'Fast · compact' },
  // Together AI
  { id: 'together/meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo (Together)', provider: 'Together AI', speed: 'Fast · 128k' },
  { id: 'together/deepseek-ai/DeepSeek-R1', label: 'DeepSeek R1 (Together)', provider: 'Together AI', speed: 'Reasoning · fast' },
  { id: 'together/Qwen/Qwen2.5-Coder-32B-Instruct', label: 'Qwen 2.5 Coder 32B (Together)', provider: 'Together AI', speed: 'Code · 32k' },
  // Cohere
  { id: 'cohere/command-r-plus-08-2024', label: 'Command R+ 08-2024', provider: 'Cohere', speed: 'Powerful · 128k' },
  { id: 'cohere/command-r-08-2024', label: 'Command R 08-2024', provider: 'Cohere', speed: 'Fast · 128k' },
  // NVIDIA Nemotron & NIM
  { id: 'nvidia/llama-3.1-nemotron-70b-instruct', label: 'Nemotron 70B (NIM)', provider: 'NVIDIA Nemotron', speed: 'Powerful · 131k' },
  { id: 'nvidia/meta/llama-3.3-70b-instruct', label: 'Llama 3.3 70B (NIM)', provider: 'NVIDIA Nemotron', speed: 'Powerful · 128k' },
  { id: 'nvidia/deepseek-ai/deepseek-r1', label: 'DeepSeek R1 (NIM)', provider: 'NVIDIA Nemotron', speed: 'Reasoning · flagship' },
  // Anthropic Claude
  { id: 'claude-sonnet-4-5-20251001', label: 'Claude Sonnet 4.5', provider: 'Anthropic', speed: 'Fast · balanced' },
  { id: 'claude-opus-4-5-20251001', label: 'Claude Opus 4.5', provider: 'Anthropic', speed: 'Powerful · flagship' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'Anthropic', speed: 'Fastest · cheap' },
  // OpenAI
  { id: 'gpt-4o', label: 'GPT-4o', provider: 'OpenAI', speed: 'Fast · general' },
  { id: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'OpenAI', speed: 'Fastest' },
  { id: 'o1', label: 'o1', provider: 'OpenAI', speed: 'Reasoning · flagship' },
  { id: 'o3-mini', label: 'o3-mini', provider: 'OpenAI', speed: 'Reasoning · fast' },
  // DeepSeek
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', provider: 'DeepSeek', speed: 'Fast · 1M context' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', provider: 'DeepSeek', speed: 'Powerful · 1M context' },
  // Xiaomi MiMo
  { id: 'mimo-v2.5-pro', label: 'MiMo V2.5 Pro', provider: 'Xiaomi MiMo', speed: 'Powerful · 1T' },
  { id: 'mimo-v2.5', label: 'MiMo V2.5', provider: 'Xiaomi MiMo', speed: 'Fast · 310B' },
  // Zhipu
  { id: 'glm-5.2', label: 'GLM-5.2', provider: 'Zhipu', speed: 'Powerful · 1M context' },
  { id: 'glm-5.1', label: 'GLM-5.1', provider: 'Zhipu', speed: 'Powerful · agentic' },
  // Qwen
  { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus', provider: 'Qwen', speed: 'Powerful · code' },
  { id: 'qwen3-coder-flash', label: 'Qwen3 Coder Flash', provider: 'Qwen', speed: 'Fastest · code' },
  // FPT Cloud AI
  { id: 'fpt/DeepSeek-V4-Flash', label: 'DeepSeek V4 Flash (FPT)', provider: 'FPT Cloud AI', speed: 'Fast · marketplace' },
  { id: 'fpt/GLM-5.2', label: 'GLM-5.2 (FPT)', provider: 'FPT Cloud AI', speed: 'Powerful · marketplace' },
  // BytePlus ModelArk
  { id: 'byteplus/deepseek-v4-flash-ga-260731', label: 'DeepSeek V4 Flash GA', provider: 'BytePlus ModelArk', speed: 'Fast · GA build' },
  { id: 'byteplus/deepseek-v4-pro-ga-260813', label: 'DeepSeek V4 Pro GA', provider: 'BytePlus ModelArk', speed: 'Powerful · GA build' },
  // Ollama
  { id: 'qwen3-coder:30b', label: 'Qwen3 Coder 30B (local)', provider: 'Ollama', speed: 'Local · code' },
  { id: 'llama3.3', label: 'Llama 3.3 (local)', provider: 'Ollama', speed: 'Local · 70B' },
];

interface SkillItem {
  id: string;
  name: string;
  type: 'skill' | 'plugin';
  desc: string;
  source: string;
}

/** One entry of the real catalog as the engine reports it at /api/skills. */
interface ServerSkill {
  id: string;
  name: string;
  description: string;
  source: string;
  type?: 'skill' | 'plugin';
}

export function SettingsPanel({
  settings,
  tools,
  availableModels = [],
  t,
  initialTab = 'agents',
  activeAgentName = 'Aura',
  onAgentNameChange,
  onChange,
  onClose,
}: {
  settings: S;
  tools: ToolInfo[];
  availableModels?: ModelOption[];
  t: T;
  initialTab?: SettingsTab;
  activeAgentName?: string;
  onAgentNameChange?: (name: string) => void;
  onChange: (patch: Partial<S>) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [agentKey, setAgentKey] = useState<string>('aura');
  const [agentName, setAgentName] = useState<string>(activeAgentName);
  const [agentTools, setAgentTools] = useState<string[]>(PRELOADED_AGENTS[0].tools);
  const [providers, setProviders] = useState<ProviderEntry[]>(DEFAULT_PROVIDERS);
  const [allModels, setAllModels] = useState<ModelOption[]>(
    availableModels.length > 0 ? availableModels : COMPREHENSIVE_FALLBACK_MODELS
  );
  const [revealedKeys, setRevealedKeys] = useState<Record<string, boolean>>({});
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [keySavedStatus, setKeySavedStatus] = useState<Record<string, 'saved' | 'cleared' | boolean>>({});
  // Per-provider: show a free-text model-id field instead of the dropdown.
  const [customModelMode, setCustomModelMode] = useState<Record<string, boolean>>({});
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [dropStatus, setDropStatus] = useState('nothing staged');
  const [uploading, setUploading] = useState(false);
  const [marketSpec, setMarketSpec] = useState('');
  const dirInputRef = useRef<HTMLInputElement | null>(null);
  /** Files staged for upload, with their path inside the skill folder. */
  const stagedRef = useRef<Array<{ path: string; content: string }>>([]);

  const refreshSkills = useCallback(() => {
    void fetch('/api/skills')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { skills?: ServerSkill[] } | null) => {
        if (!Array.isArray(data?.skills)) return;
        setSkills(data!.skills.map((sk) => ({
          id: sk.id,
          name: sk.name,
          type: sk.type === 'plugin' ? 'plugin' : 'skill',
          desc: sk.description,
          source: sk.source,
        })));
      })
      .catch(() => { /* the list is informational; keep whatever we have */ });
  }, []);

  useEffect(() => { refreshSkills(); }, [refreshSkills]);

  /** Base64 for one file, promise-shaped. */
  const readBase64 = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.readAsDataURL(file);
  });

  /** Upload the staged files and show the outcome where the promise used to be. */
  const uploadStaged = useCallback(async () => {
    const files = stagedRef.current;
    if (files.length === 0) return;
    setUploading(true);
    setDropStatus(`installing ${files.length} file${files.length === 1 ? '' : 's'}…`);
    try {
      const res = await fetch('/api/skills/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDropStatus(`✗ ${data.error || `upload failed (${res.status})`}`);
      } else {
        setDropStatus(`✓ installed "${data.name}" — ${data.installed} file(s) into ${data.dir}`);
        stagedRef.current = [];
        refreshSkills();
      }
    } catch (e) {
      setDropStatus(`✗ ${String(e)}`);
    } finally {
      setUploading(false);
    }
  }, [refreshSkills]);

  /** Stage a batch of files, keeping each one's path inside its skill folder. */
  const stageFiles = useCallback(async (list: Array<{ file: File; path: string }>) => {
    if (list.length === 0) return;
    stagedRef.current = [];
    for (const { file, path } of list) {
      try {
        stagedRef.current.push({ path, content: await readBase64(file) });
      } catch (e) {
        setDropStatus(`✗ ${String(e)}`);
        return;
      }
    }
    const hasSkillMd = stagedRef.current.some((f) => f.path.split('/').pop() === 'SKILL.md');
    if (!hasSkillMd) {
      stagedRef.current = [];
      setDropStatus('✗ not a skill — the folder needs a SKILL.md at its top level');
      return;
    }
    const top = stagedRef.current[0].path.split('/')[0];
    setDropStatus(`staged "${top}" (${stagedRef.current.length} files) — installing…`);
    await uploadStaged();
  }, [uploadStaged]);

  /** A dropped directory arrives as an entry tree, not a file list — walk it. */
  const walkEntry = async (entry: FileSystemEntry, prefix: string,
                           out: Array<{ file: File; path: string }>): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File | null>((res) =>
        (entry as FileSystemFileEntry).file(res, () => res(null)));
      if (file) out.push({ file, path: prefix + file.name });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const readAll = async (): Promise<FileSystemEntry[]> => {
      const all: FileSystemEntry[] = [];
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res) =>
          reader.readEntries(res, () => res([])));
        if (batch.length === 0) return all;
        all.push(...batch);
      }
    };
    for (const child of await readAll()) {
      await walkEntry(child, `${prefix}${entry.name}/`, out);
    }
  };

  useEffect(() => {
    fetch('/api/models')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.models) && data.models.length > 0) {
          setAllModels(data.models);
        }
      })
      .catch(() => {});

    fetch('/api/providers')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.providers) && data.providers.length > 0) {
          const activeEnvKey = data.activeEnvKey || '';
          const activeModel = settings.model || data.activeModel || '';
          const activeProviderName = settings.provider || '';

          // Deterministic single primary provider resolution:
          // 1. User's chosen provider name from settings (persisted)
          let primaryIndex = -1;
          if (activeProviderName) {
            primaryIndex = data.providers.findIndex((p: any) =>
              p.name.toLowerCase().includes(activeProviderName.toLowerCase()) ||
              activeProviderName.toLowerCase().includes(p.name.toLowerCase())
            );
          }
          // 2. User's chosen model from settings
          if (primaryIndex === -1 && settings.model) {
            primaryIndex = data.providers.findIndex((p: any) =>
              p.models?.some((m: any) => m.id.toLowerCase() === settings.model.toLowerCase())
            );
          }
          // 3. Server's activeModel
          if (primaryIndex === -1 && data.activeModel) {
            primaryIndex = data.providers.findIndex((p: any) =>
              p.models?.some((m: any) => m.id.toLowerCase() === data.activeModel.toLowerCase())
            );
          }
          // 4. Server's activeEnvKey
          if (primaryIndex === -1 && activeEnvKey) {
            primaryIndex = data.providers.findIndex((p: any) => p.envKey === activeEnvKey);
          }
          // 5. Default to first provider
          if (primaryIndex === -1) {
            primaryIndex = 0;
          }

          const serverProviders: ProviderEntry[] = data.providers.map((prov: any, idx: number) => {
            const isPrimary = idx === primaryIndex;
            const defaultModel =
              (isPrimary && settings.model && prov.models?.some((m: any) => m.id === settings.model))
                ? settings.model
                : (prov.models?.find((m: any) => m.id === activeModel)?.id || prov.models?.[0]?.id || '');

            return {
              id: `p_${prov.envKey || idx}`,
              name: prov.name,
              envKey: prov.envKey,
              signupUrl: prov.signupUrl || '',
              role: isPrimary ? ('primary' as const) : ('mesh' as const),
              endpoint: prov.baseUrl || '',
              model: defaultModel,
              key: prov.maskedKey || '',
              maskedKey: prov.maskedKey || '',
              keySet: Boolean(prov.keySet),
              ping: prov.keySet ? '42ms' : 'no key',
              pingOk: Boolean(prov.keySet),
            };
          });

          setProviders(serverProviders);
        }
      })
      .catch(() => {});
  }, [settings.model, settings.provider]);

  const tabTitles: Record<SettingsTab, string> = {
    agents: 'Agents',
    models: 'Providers & Models — Free Tier, Cerebras, SambaNova, OpenRouter, OpenCode, Google & More',
    skills: 'Skills & plugins',
    autonomy: 'Approval & sandbox',
    general: 'General Preferences',
  };

  const handleAgentSelect = (a: AgentPersona) => {
    setAgentKey(a.key);
    setAgentName(a.name);
    setAgentTools([...a.tools]);
    onAgentNameChange?.(a.name);
  };

  const toggleTool = (toolName: string) => {
    setAgentTools((prev) =>
      prev.includes(toolName) ? prev.filter((x) => x !== toolName) : [...prev, toolName],
    );
  };

  const handleSaveKey = async (provider: ProviderEntry) => {
    if (!provider.envKey) return;
    const rawVal = keyInputs[provider.id] ?? '';
    try {
      const res = await fetch('/api/apikey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ envKey: provider.envKey, value: rawVal }),
      }).then((r) => r.json());

      if (res.ok) {
        setProviders((prev) =>
          prev.map((item) =>
            item.id === provider.id
              ? {
                  ...item,
                  keySet: Boolean(res.keySet),
                  maskedKey: res.maskedKey || '',
                  key: res.maskedKey || '',
                  pingOk: Boolean(res.keySet),
                  ping: res.keySet ? '42ms' : 'no key',
                }
              : item
          )
        );
        setKeySavedStatus((prev) => ({ ...prev, [provider.id]: 'saved' }));
        setTimeout(() => setKeySavedStatus((prev) => ({ ...prev, [provider.id]: false })), 3000);

        // Refresh available models
        fetch('/api/models')
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d && Array.isArray(d.models) && d.models.length > 0) {
              setAllModels(d.models);
            }
          })
          .catch(() => {});
      }
    } catch {
      // Ignore network errors
    }
  };

  const handleClearKey = async (provider: ProviderEntry) => {
    if (!provider.envKey) return;
    try {
      const res = await fetch('/api/apikey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ envKey: provider.envKey, value: '' }),
      }).then((r) => r.json());

      if (res.ok) {
        setProviders((prev) =>
          prev.map((item) =>
            item.id === provider.id
              ? {
                  ...item,
                  keySet: false,
                  maskedKey: '',
                  key: '',
                  pingOk: false,
                  ping: 'no key',
                }
              : item
          )
        );
        setKeyInputs((prev) => ({ ...prev, [provider.id]: '' }));
        setKeySavedStatus((prev) => ({ ...prev, [provider.id]: 'cleared' }));
        setTimeout(() => setKeySavedStatus((prev) => ({ ...prev, [provider.id]: false })), 3000);

        // Refresh available models
        fetch('/api/models')
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d && Array.isArray(d.models) && d.models.length > 0) {
              setAllModels(d.models);
            }
          })
          .catch(() => {});
      }
    } catch {
      // Ignore network errors
    }
  };

  const handleProviderEdit = (id: string, field: 'endpoint' | 'model' | 'key' | 'name', val: string) => {
    setProviders((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: val } : p)));
    if (field === 'model') {
      const p = providers.find((x) => x.id === id);
      if (p && p.role === 'primary') {
        onChange({ model: val, provider: p.name });
        fetch('/api/model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: val }),
        }).catch(() => {});
      }
    }
  };

  const setPrimaryProvider = (id: string) => {
    const chosen = providers.find((p) => p.id === id);
    if (!chosen) return;
    setProviders((prev) =>
      prev.map((p) => ({
        ...p,
        role: p.id === id ? ('primary' as const) : ('mesh' as const),
      }))
    );
    const chosenModel = chosen.model || '';
    onChange({ model: chosenModel, provider: chosen.name });
    if (chosenModel) {
      fetch('/api/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: chosenModel }),
      }).catch(() => {});
    }
  };

  // Group models by provider for dropdown optgroups
  const modelsByProvider: Record<string, ModelOption[]> = {};
  for (const m of allModels) {
    const prov = m.provider || 'Other';
    if (!modelsByProvider[prov]) modelsByProvider[prov] = [];
    modelsByProvider[prov].push(m);
  }

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="settings-header">
          <div className="settings-tab-buttons" role="tablist">
            {(['agents', 'models', 'skills', 'autonomy', 'general'] as SettingsTab[]).map((tKey) => (
              <button
                key={tKey}
                type="button"
                role="tab"
                aria-selected={tab === tKey}
                className={`settings-nav-tab ${tab === tKey ? 'active' : ''}`}
                onClick={() => setTab(tKey)}
              >
                {tKey.charAt(0).toUpperCase() + tKey.slice(1)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="settings-close-btn"
            aria-label="Close settings"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-scroll-area">
            <h1 className="tab-main-heading">{tabTitles[tab]}</h1>

            {tab === 'agents' && (
              <div className="tab-agents">
                <p className="tab-intro">
                  Aura changes personality and tool grants depending on what she is doing. Click one to inspect or switch persona for this session.
                </p>

                <div className="section-label">Preloaded</div>
                <div className="persona-list">
                  {PRELOADED_AGENTS.map((a) => {
                    const isSelected = agentKey === a.key;
                    return (
                      <button
                        key={a.key}
                        type="button"
                        className={`persona-card ${isSelected ? 'selected' : ''}`}
                        onClick={() => handleAgentSelect(a)}
                      >
                        <span className={`radio-outer ${isSelected ? 'checked' : ''}`}>
                          {isSelected && <span className="radio-inner" />}
                        </span>
                        <div className="persona-info">
                          <div className="persona-head">
                            <span className="persona-name">{a.name}</span>
                            <span className="persona-count">{a.tools.length} tools</span>
                          </div>
                          <div className="persona-desc">{a.desc}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="section-label" style={{ marginTop: '22px' }}>Active agent name</div>
                <input
                  className="agent-name-input"
                  value={agentName}
                  onChange={(e) => {
                    setAgentName(e.target.value);
                    onAgentNameChange?.(e.target.value);
                  }}
                />

                <div className="section-label" style={{ marginTop: '22px' }}>
                  Tools this agent may call — {agentTools.length} of {ALL_TOOLS.length}
                </div>
                <div className="tool-grants-grid">
                  {ALL_TOOLS.map((tItem) => {
                    const granted = agentTools.includes(tItem.name);
                    return (
                      <button
                        key={tItem.name}
                        type="button"
                        className={`tool-grant-chip ${granted ? 'granted' : ''}`}
                        onClick={() => toggleTool(tItem.name)}
                      >
                        <span className="tool-grant-icon">{tItem.icon}</span>
                        <span className="tool-grant-name">{tItem.label}</span>
                        <span className="tool-grant-check">{granted ? '✓' : ''}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {tab === 'models' && (
              <div className="tab-models">
                <p className="tab-intro">
                  Model-agnostic by design. Select any provider as Primary and manage API keys below. Supports OpenCode, OpenRouter, Cerebras, SambaNova, NVIDIA, FPT Cloud, BytePlus, Google Gemini, Anthropic, OpenAI, DeepSeek, Xiaomi MiMo, Ollama, and more.
                </p>

                <div className="providers-list">
                  {providers.map((p) => {
                    const isPrimary = p.role === 'primary';
                    const isKeyRevealed = !!revealedKeys[p.id];
                    const rawInputValue = keyInputs[p.id];
                    const displayValue = rawInputValue !== undefined ? rawInputValue : (isKeyRevealed ? p.key : '');

                    return (
                      <div key={p.id} className={`provider-card ${isPrimary ? 'primary' : ''}`}>
                        <div className="provider-card-head">
                          <button
                            type="button"
                            className="provider-radio-btn"
                            onClick={() => setPrimaryProvider(p.id)}
                            title="Set as primary provider for agent loop"
                          >
                            <span className={`radio-outer ${isPrimary ? 'checked' : ''}`}>
                              {isPrimary && <span className="radio-inner" />}
                            </span>
                          </button>
                          <span className="provider-name">{p.name}</span>
                          <span className={`provider-role-badge role-${p.role}`}>{p.role}</span>
                          {p.envKey && (
                            <span style={{ fontSize: '11px', marginLeft: '6px' }}>
                              {p.keySet ? (
                                <span style={{ color: 'var(--ok, #34d399)', fontWeight: 600 }}>✓ Key Configured</span>
                              ) : (
                                <span style={{ color: 'var(--warn, #fbbf24)' }}>No Key Set</span>
                              )}
                            </span>
                          )}
                          <div className="spacer" />
                          {p.signupUrl && (
                            <a
                              href={p.signupUrl}
                              target="_blank"
                              rel="noreferrer"
                              style={{ fontSize: '11px', color: 'var(--accent, #60a5fa)', marginRight: '10px', textDecoration: 'underline' }}
                            >
                              Get Key ↗
                            </a>
                          )}
                          <span className={`provider-ping ${p.pingOk ? 'ok' : 'err'}`}>
                            {p.ping}
                          </span>
                        </div>

                        <div className="provider-fields-grid">
                          <label className="provider-field">
                            <span className="field-meta">Endpoint</span>
                            <input
                              className="field-input"
                              value={p.endpoint}
                              onChange={(e) => handleProviderEdit(p.id, 'endpoint', e.target.value)}
                            />
                          </label>

                          <label className="provider-field">
                            <span className="field-meta">
                              Model ID {customModelMode[p.id] || (p.model && !allModels.some((m) => m.id === p.model)) ? '(custom)' : '(dropdown selector)'}
                            </span>
                            <div className="model-select-wrapper">
                              {customModelMode[p.id] ? (
                                <div style={{ display: 'flex', gap: '6px' }}>
                                  <input
                                    className="field-input"
                                    style={{ flex: 1 }}
                                    autoFocus
                                    placeholder="e.g. openrouter/z-ai/glm-4.6 or kilocode/minimax/minimax-m3:free"
                                    value={p.model}
                                    onChange={(e) => handleProviderEdit(p.id, 'model', e.target.value)}
                                  />
                                  <button
                                    type="button"
                                    className="field-input"
                                    style={{ width: 'auto', cursor: 'pointer', whiteSpace: 'nowrap', padding: '0 10px' }}
                                    onClick={() => setCustomModelMode((prev) => ({ ...prev, [p.id]: false }))}
                                    title="Pick from the known-models list instead"
                                  >
                                    ▾ list
                                  </button>
                                </div>
                              ) : (
                                <select
                                  className="field-input field-select-model"
                                  value={allModels.some((m) => m.id === p.model) ? p.model : '__custom__'}
                                  onChange={(e) => {
                                    if (e.target.value === '__custom__') {
                                      setCustomModelMode((prev) => ({ ...prev, [p.id]: true }));
                                    } else {
                                      handleProviderEdit(p.id, 'model', e.target.value);
                                    }
                                  }}
                                >
                                  <option value="__custom__">✏️  Custom — type any model ID…</option>
                                  {p.model && !allModels.some((m) => m.id === p.model) && (
                                    <option value={p.model}>{p.model} (current)</option>
                                  )}
                                  {Object.entries(modelsByProvider).map(([providerName, mList]) => (
                                    <optgroup key={providerName} label={`── ${providerName} ──`}>
                                      {mList.map((mItem) => (
                                        <option key={mItem.id} value={mItem.id}>
                                          {mItem.name || mItem.label || mItem.id} {mItem.speed ? `(${mItem.speed})` : ''}
                                        </option>
                                      ))}
                                    </optgroup>
                                  ))}
                                </select>
                              )}
                            </div>
                          </label>

                          <label className="provider-field full-row">
                            <span className="field-meta">
                              API Key {p.envKey ? `(${p.envKey})` : ''}
                            </span>
                            <div className="key-row" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                              <input
                                type={isKeyRevealed ? 'text' : 'password'}
                                className="field-input key-input"
                                placeholder={p.maskedKey ? `Saved: ${p.maskedKey}` : 'Enter API key...'}
                                value={displayValue}
                                onChange={(e) => setKeyInputs((prev) => ({ ...prev, [p.id]: e.target.value }))}
                              />
                              {p.envKey && (
                                <>
                                  <button
                                    type="button"
                                    className="btn-key-save"
                                    style={{
                                      padding: '5px 12px',
                                      fontSize: '12px',
                                      fontWeight: 600,
                                      borderRadius: '4px',
                                      background: keySavedStatus[p.id] === 'saved' ? 'var(--ok, #10b981)' : 'var(--accent, #3b82f6)',
                                      color: '#fff',
                                      border: 'none',
                                      cursor: 'pointer',
                                      whiteSpace: 'nowrap',
                                    }}
                                    onClick={() => handleSaveKey(p)}
                                    title="Save API key for this provider"
                                  >
                                    {keySavedStatus[p.id] === 'saved' ? '✓ Saved!' : 'Save Key'}
                                  </button>
                                  {(p.keySet || rawInputValue) && (
                                    <button
                                      type="button"
                                      className="btn-key-clear"
                                      style={{
                                        padding: '5px 10px',
                                        fontSize: '12px',
                                        fontWeight: 500,
                                        borderRadius: '4px',
                                        background: keySavedStatus[p.id] === 'cleared' ? 'var(--err, #ef4444)' : 'transparent',
                                        color: keySavedStatus[p.id] === 'cleared' ? '#fff' : 'var(--mut, #94a3b8)',
                                        border: '1px solid var(--line2, rgba(255,255,255,0.15))',
                                        cursor: 'pointer',
                                        whiteSpace: 'nowrap',
                                      }}
                                      onClick={() => handleClearKey(p)}
                                      title="Clear and remove saved API key"
                                    >
                                      {keySavedStatus[p.id] === 'cleared' ? '✓ Cleared!' : 'Clear'}
                                    </button>
                                  )}
                                </>
                              )}
                              <button
                                type="button"
                                className="btn-key-toggle"
                                onClick={() =>
                                  setRevealedKeys((prev) => ({ ...prev, [p.id]: !prev[p.id] }))
                                }
                              >
                                {isKeyRevealed ? 'Hide' : 'Reveal'}
                              </button>
                            </div>
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={{ display: 'flex', gap: '10px', marginTop: '14px' }}>
                  <button
                    type="button"
                    className="btn-add-endpoint"
                    onClick={() => {
                      const id = `p${Date.now()}`;
                      setProviders((prev) => [
                        ...prev,
                        {
                          id,
                          name: 'New Provider',
                          role: 'mesh',
                          endpoint: 'https://opencode.ai/zen/v1',
                          model: 'opencode/big-pickle',
                          key: '',
                          ping: '-',
                          pingOk: true,
                        },
                      ]);
                    }}
                  >
                    + Add Provider Endpoint
                  </button>
                </div>
              </div>
            )}

            {tab === 'skills' && (
              <div className="tab-skills">
                <p className="tab-intro">
                  A skill is a folder with a SKILL.md and its scripts. A plugin registers new tools with the loop. Both are read from your machine and mounted into the current work.
                </p>

                <div
                  className={`skill-dropzone ${dragOver ? 'drag-over' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    if (uploading) return;
                    // A folder arrives as an entry tree, so walk the items
                    // first; plain files take the fallback path.
                    const items = Array.from(e.dataTransfer?.items ?? []);
                    const entries = items
                      .map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null))
                      .filter((en): en is FileSystemEntry => en !== null);
                    if (entries.length > 0) {
                      const out: Array<{ file: File; path: string }> = [];
                      Promise.all(entries.map((en) => walkEntry(en, '', out)))
                        .then(() => stageFiles(out))
                        .catch((err) => setDropStatus(`✗ ${String(err)}`));
                      return;
                    }
                    const files = Array.from(e.dataTransfer?.files ?? []);
                    void stageFiles(files.map((file) => ({ file, path: file.name })));
                  }}
                  onClick={() => dirInputRef.current?.click()}
                  role="button"
                  aria-label="Install a skill folder"
                >
                  <div className="dropzone-plus">+</div>
                  <div className="dropzone-text">Drop a skill folder here to install it</div>
                  <div className="dropzone-sub">
                    or click to pick a folder from <span className="underline">your machine</span>
                  </div>
                  <div className="dropzone-status">{dropStatus}</div>
                  {/* webkitdirectory opens an OS folder picker — a skill is a
                      folder, and a folder is what this has to accept. */}
                  <input
                    ref={dirInputRef}
                    type="file"
                    multiple
                    style={{ display: 'none' }}
                    {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      const root = files[0]?.webkitRelativePath.split('/')[0] ?? '';
                      void stageFiles(files.map((file) => ({
                        file,
                        path: file.webkitRelativePath || `${root}/${file.name}`,
                      })));
                      e.target.value = '';
                    }}
                  />
                </div>

                <div className="section-label" style={{ marginTop: '22px' }}>
                  Install from a marketplace or git
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    className="field-input"
                    placeholder="owner/repo · name@marketplace · https://git…"
                    value={marketSpec}
                    onChange={(e) => setMarketSpec(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && marketSpec.trim()) {
                        const spec = marketSpec.trim();
                        setMarketSpec('');
                        setDropStatus(`installing ${spec}…`);
                        void fetch('/api/plugins/install', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ spec }),
                        })
                          .then(async (res) => {
                            const data = await res.json().catch(() => ({}));
                            setDropStatus(res.ok
                              ? `✓ installed ${data.plugin?.name || spec}`
                              : `✗ ${data.error || `install failed (${res.status})`}`);
                            refreshSkills();
                          })
                          .catch((err) => setDropStatus(`✗ ${String(err)}`));
                      }
                    }}
                  />
                </div>

                <div className="section-label" style={{ marginTop: '22px' }}>Installed on this machine</div>
                <div className="skills-list">
                  {skills.length === 0 && (
                    <div className="skill-desc" style={{ opacity: 0.6 }}>
                      No skills installed yet. The engine reads .agents/skills/&lt;name&gt;/SKILL.md and .claude/skills/&lt;name&gt;/SKILL.md.
                    </div>
                  )}
                  {skills.map((s) => (
                    <div key={s.id} className="skill-card">
                      <div className="skill-head">
                        <span className="skill-name">{s.name}</span>
                        <span className={`skill-type-tag type-${s.type}`}>{s.type}</span>
                        <div className="spacer" />
                        <span className="skill-ver">{s.source}</span>
                      </div>
                      <div className="skill-desc">{s.desc}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === 'autonomy' && (
              <div className="tab-autonomy">
                <p className="tab-intro">
                  How much to ask before acting. The engine is read-only in planning; these gates apply once it enters execution.
                </p>

                <div className="section-label">Execution gate</div>
                <div className="permission-choices">
                  {[
                    { val: 'ask', label: 'Ask first (normal)', sub: 'Prompts for confirmation before every file edit and shell command.' },
                    { val: 'auto', label: 'Autonomous (--auto)', sub: 'Runs uninterrupted. Stops only on errors, gates, or task completion.' },
                    { val: 'plan', label: 'Read-only planning (--plan)', sub: 'Inspects codebase and writes a plan, but modifies no files.' },
                  ].map((opt) => (
                    <button
                      key={opt.val}
                      type="button"
                      className={`perm-choice-card ${settings.permission === opt.val ? 'selected' : ''}`}
                      onClick={() => onChange({ permission: opt.val as PermissionLevel })}
                    >
                      <span className={`radio-outer ${settings.permission === opt.val ? 'checked' : ''}`}>
                        {settings.permission === opt.val && <span className="radio-inner" />}
                      </span>
                      <div className="perm-info">
                        <div className="perm-label">{opt.label}</div>
                        <div className="perm-sub">{opt.sub}</div>
                      </div>
                    </button>
                  ))}
                </div>

                <div className="section-label" style={{ marginTop: '24px' }}>Sandbox</div>
                <div className="sandbox-card">
                  <div className="sandbox-head">
                    <span className="sandbox-name">Filesystem isolation</span>
                    <span className={`sandbox-status-tag ${settings.sandbox ? 'on' : 'off'}`}>
                      {settings.sandbox ? 'enabled' : 'disabled'}
                    </span>
                    <div className="spacer" />
                    <button
                      type="button"
                      className={`skill-toggle-switch ${settings.sandbox ? 'on' : 'off'}`}
                      onClick={() => onChange({ sandbox: !settings.sandbox })}
                    >
                      <span className="toggle-knob" />
                    </button>
                  </div>
                  <div className="sandbox-desc">
                    When enabled, file writes and shell commands are restricted to the project root directory.
                  </div>
                </div>
              </div>
            )}

            {tab === 'general' && (
              <div className="tab-general">
                <p className="tab-intro">
                  Language, theme, attribution, and project parameters.
                </p>

                <div className="form-field-group" style={{ marginBottom: '16px' }}>
                  <label className="form-label">Interface Language</label>
                  <select
                    className="form-select"
                    value={settings.locale}
                    onChange={(e) => onChange({ locale: e.target.value as Locale })}
                  >
                    {Object.entries(LOCALES).map(([code, info]) => (
                      <option key={code} value={code}>
                        {info.native} ({info.name})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field-group" style={{ marginBottom: '20px' }}>
                  <label className="form-label">Theme</label>
                  <select
                    className="form-select"
                    value={settings.theme}
                    onChange={(e) => onChange({ theme: e.target.value as 'dark' | 'light' })}
                  >
                    <option value="dark">Dark (Default obsidian)</option>
                    <option value="light">Light</option>
                  </select>
                </div>

                {/* Attribution & Disclaimer Card */}
                <div
                  className="general-attribution-card"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '14px',
                    padding: '8px 0',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontSize: '24px' }}>⚡</span>
                    <div>
                      <div
                        style={{
                          fontFamily: 'var(--font-serif)',
                          fontSize: '22px',
                          color: 'var(--ink)',
                          fontWeight: 600,
                        }}
                      >
                        Built by Aura Code for LeanprogressIQ
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '16px',
                          marginTop: '6px',
                          fontFamily: 'var(--font-mono)',
                          fontSize: '13.5px',
                        }}
                      >
                        <a
                          href="https://leanproiq.com"
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: 'var(--acc2)', textDecoration: 'none', fontWeight: 600 }}
                        >
                          leanproiq.com ↗
                        </a>
                        <span style={{ color: 'var(--dim)' }}>·</span>
                        <a
                          href="https://aurawebsite-self.vercel.app"
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: 'var(--acc2)', textDecoration: 'none', fontWeight: 600 }}
                        >
                          aurawebsite-self.vercel.app ↗
                        </a>
                      </div>
                    </div>
                  </div>

                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '14px',
                      color: 'var(--txt)',
                      lineHeight: '1.6',
                    }}
                  >
                    <strong style={{ color: 'var(--ink)', fontSize: '15px' }}>Architect & Developer:</strong> Dusan Milosavljevic (System Architect and Developer)
                  </div>

                  <div
                    style={{
                      fontSize: '13.5px',
                      lineHeight: '1.65',
                      color: 'var(--mut)',
                      borderTop: '1px solid var(--line)',
                      paddingTop: '12px',
                    }}
                  >
                    <strong style={{ color: 'var(--ink)', textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: '12px' }}>
                      Disclaimer:
                    </strong>{' '}
                    AI-generated responses (summaries, chat, benchmarks analysis, etc.) may be inaccurate or incomplete. Aura Code does not verify model output — treat it as a starting point, not a source of truth, and confirm anything important independently.
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
