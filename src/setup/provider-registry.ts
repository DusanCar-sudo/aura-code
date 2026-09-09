/**
 * Provider registry — all supported LLM providers with their endpoints,
 * models, env var keys, and signup URLs.
 *
 * Used by the provider wizard to let users interactively configure their
 * provider without manual env vars or --base-url flags.
 */
import { getApiKey } from '../util/env.js';
import { loadGlobalConfig } from './global-config.js';

export interface ProviderModel {
  id: string;
  label: string;
  speed: string;
  contextWindow: number;
}

export interface ProviderEntry {
  name: string;
  baseUrl: string;
  envKey: string | null;
  signupUrl: string;
  models: ProviderModel[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

export const PROVIDER_REGISTRY: ProviderEntry[] = [
  {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    signupUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', speed: 'Fast', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', speed: 'Powerful', contextWindow: 1_000_000 },
      // Vision + reasoning. Experimental build, so the context window is the
      // conservative documented figure rather than flash's 1M. Note it spends
      // completion budget on reasoning tokens before emitting any content — a
      // small max_tokens comes back empty, not short.
      { id: 'deepseek-v4-flash-vision-exp', label: 'DeepSeek V4 Flash Vision (exp)', speed: 'Vision · reasoning', contextWindow: 128_000 },
    ],
  },
  {
    name: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com',
    envKey: 'ANTHROPIC_API_KEY',
    signupUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-sonnet-4-5-20251001', label: 'Claude Sonnet 4.5', speed: 'Fast', contextWindow: 200_000 },
      { id: 'claude-opus-4-5-20251001', label: 'Claude Opus 4.5', speed: 'Powerful', contextWindow: 200_000 },
    ],
  },
  {
    name: 'OpenAI (GPT)',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    signupUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o', speed: 'Fast', contextWindow: 128_000 },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini', speed: 'Fast', contextWindow: 128_000 },
      { id: 'o1', label: 'o1', speed: 'Reasoning', contextWindow: 200_000 },
    ],
  },
  {
    name: 'Google (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    envKey: 'GOOGLE_API_KEY',
    signupUrl: 'https://aistudio.google.com/apikey',
    // The 2.5 line still appears in Google's /models listing but answers
    // generateContent with 404 "no longer available to new users" — a listing
    // is not an entitlement. Every id below was confirmed with a live
    // generateContent call on an AI Studio key.
    models: [
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', speed: 'Powerful · reasoning', contextWindow: 1_000_000 },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', speed: 'Fast', contextWindow: 1_000_000 },
      { id: 'gemini-pro-latest', label: 'Gemini Pro (latest)', speed: 'Powerful', contextWindow: 1_000_000 },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', speed: 'Fast', contextWindow: 1_000_000 },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', speed: 'Fastest · cheap', contextWindow: 1_000_000 },
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', speed: 'Fast · cheap', contextWindow: 1_000_000 },
    ],
  },
  {
    name: 'Google Vertex AI',
    baseUrl: 'https://aiplatform.googleapis.com',
    envKey: 'GOOGLE_VERTEX_ACCESS_TOKEN',
    signupUrl: 'https://console.cloud.google.com/vertex-ai',
    models: [
      { id: 'vertex/gemini-3.6-flash', label: 'Gemini 3.6 Flash (Vertex)', speed: 'Fast', contextWindow: 1_000_000 },
      { id: 'vertex/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Vertex)', speed: 'Powerful · reasoning', contextWindow: 1_000_000 },
      { id: 'vertex/gemini-pro-latest', label: 'Gemini Pro (Vertex)', speed: 'Powerful', contextWindow: 1_000_000 },
      { id: 'vertex/gemini-3.5-flash', label: 'Gemini 3.5 Flash (Vertex)', speed: 'Fast', contextWindow: 1_000_000 },
    ],
  },
  {
    name: 'Xiaomi MiMo',
    envKey: 'XIAOMI_API_KEY',
    baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
    signupUrl: 'https://platform.xiaomimimo.com/#/console/api-keys',
    models: [
      { id: 'mimo-v2.5-pro', label: 'MiMo V2.5 Pro', speed: 'Powerful · Token Plan', contextWindow: 1_048_576 },
      { id: 'mimo-v2.5', label: 'MiMo V2.5', speed: 'Fast · Token Plan', contextWindow: 1_048_576 },
    ],
  },
  {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    signupUrl: 'https://openrouter.ai/keys',
    models: [
      { id: 'openrouter/google/gemini-2.0-flash-lite-001:free', label: 'Gemini 2.0 Flash Lite (free)', speed: 'Fast · free', contextWindow: 1_000_000 },
      { id: 'openrouter/meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (free)', speed: 'Powerful · free', contextWindow: 128_000 },
      { id: 'openrouter/deepseek/deepseek-r1:free', label: 'DeepSeek R1 (free)', speed: 'Reasoning · free', contextWindow: 128_000 },
      { id: 'openrouter/qwen/qwen-2.5-coder-32b-instruct:free', label: 'Qwen 2.5 Coder 32B (free)', speed: 'Code · free', contextWindow: 32_768 },
      { id: 'openrouter/auto', label: 'Auto (best available)', speed: 'Auto', contextWindow: 128_000 },
    ],
  },
  {
    name: 'Cerebras (Free Wafer-Scale)',
    baseUrl: 'https://api.cerebras.ai/v1',
    envKey: 'CEREBRAS_API_KEY',
    signupUrl: 'https://cloud.cerebras.ai',
    models: [
      { id: 'cerebras/llama-3.3-70b', label: 'Llama 3.3 70B (Ultra-fast free)', speed: 'Ultra-fast · free', contextWindow: 128_000 },
      { id: 'cerebras/llama3.1-8b', label: 'Llama 3.1 8B (Instant free)', speed: 'Instant · free', contextWindow: 128_000 },
      { id: 'cerebras/deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 70B (Free reasoning)', speed: 'Reasoning · free', contextWindow: 128_000 },
      { id: 'cerebras/gpt-oss-120b', label: 'GPT OSS 120B (Free)', speed: 'Powerful · free', contextWindow: 128_000 },
    ],
  },
  {
    name: 'SambaNova Cloud (Free Tier)',
    baseUrl: 'https://api.sambanova.ai/v1',
    envKey: 'SAMBANOVA_API_KEY',
    signupUrl: 'https://cloud.sambanova.ai',
    models: [
      { id: 'sambanova/Meta-Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B (Free tier)', speed: 'Ultra-fast · free', contextWindow: 128_000 },
      { id: 'sambanova/DeepSeek-R1-Distill-Llama-70B', label: 'DeepSeek R1 70B (Free tier)', speed: 'Reasoning · free', contextWindow: 128_000 },
      { id: 'sambanova/Meta-Llama-3.1-405B-Instruct', label: 'Llama 3.1 405B (Free tier)', speed: 'Powerful · free', contextWindow: 128_000 },
    ],
  },
  {
    name: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    envKey: 'XAI_API_KEY',
    signupUrl: 'https://console.x.ai',
    models: [
      { id: 'grok-2', label: 'Grok 2', speed: 'Powerful', contextWindow: 131_072 },
    ],
  },
  {
    // Free-tier ids churn fast on the Zen gateway: gpt-5-nano now answers 500,
    // and minimax-m2.5-free / nemotron-3-super-free / ling-2.6-flash-free were
    // removed from /models entirely. Every id below was confirmed against a
    // live completion; `aura --models` lists the current set.
    name: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    envKey: 'OPENCODE_API_KEY',
    signupUrl: 'https://opencode.ai',
    models: [
      { id: 'opencode/big-pickle', label: 'Big Pickle (free)', speed: 'Powerful · free', contextWindow: 128_000 },
      { id: 'opencode/mimo-v2.5-free', label: 'MiMo V2.5 (free)', speed: 'Fast · free', contextWindow: 128_000 },
      { id: 'opencode/nemotron-3-ultra-free', label: 'Nemotron 3 Ultra (free)', speed: 'Powerful · free', contextWindow: 128_000 },
      { id: 'opencode/hy3-free', label: 'HY3 (free)', speed: 'Fast · free', contextWindow: 128_000 },
      { id: 'opencode/gpt-5.4', label: 'GPT-5.4', speed: 'Powerful · paid', contextWindow: 400_000 },
      { id: 'opencode/claude-sonnet-5', label: 'Claude Sonnet 5', speed: 'Powerful · paid', contextWindow: 200_000 },
    ],
  },
  {
    // Same gateway, separate subscription and key. Kept distinct so a Go
    // subscription's balance problems don't read as a broken Zen key.
    name: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/zen/v1',
    envKey: 'OPENCODE_GO_API_KEY',
    signupUrl: 'https://opencode.ai',
    models: [
      { id: 'go-anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', speed: 'Powerful', contextWindow: 200_000 },
      { id: 'go-anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5', speed: 'Fast', contextWindow: 200_000 },
      { id: 'go-anthropic/claude-opus-5', label: 'Claude Opus 5', speed: 'Powerful', contextWindow: 200_000 },
    ],
  },
  {
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    envKey: 'NVIDIA_API_KEY',
    signupUrl: 'https://build.nvidia.com',
    models: [
      { id: 'nvidia/llama-3.1-nemotron-70b-instruct', label: 'Nemotron 70B', speed: 'Powerful', contextWindow: 131_072 },
    ],
  },
  {
    name: 'GLM (Zhipu)',
    // General endpoint as default; the wizard swaps in the Coding Plan
    // endpoint when the user picks that plan.
    baseUrl: 'https://api.z.ai/api/paas/v4',
    envKey: 'ZHIPU_API_KEY',
    signupUrl: 'https://z.ai',
    models: [
      { id: 'glm-5.2', label: 'GLM-5.2', speed: 'Powerful · 1M context', contextWindow: 1_000_000 },
      { id: 'glm-5.1', label: 'GLM-5.1', speed: 'Powerful · agentic', contextWindow: 200_000 },
      { id: 'glm-5',   label: 'GLM-5',   speed: 'Powerful · 744B MoE', contextWindow: 200_000 },
    ],
  },
  {
    name: 'Qwen (DashScope)',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    envKey: 'DASHSCOPE_API_KEY',
    signupUrl: 'https://dashscope.console.aliyun.com/',
    models: [
      { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus', speed: 'Powerful · code', contextWindow: 128_000 },
      { id: 'qwen3-coder-flash', label: 'Qwen3 Coder Flash', speed: 'Fastest · code', contextWindow: 128_000 },
      { id: 'qwen3-max', label: 'Qwen3 Max', speed: 'Reasoning · flagship', contextWindow: 128_000 },
      { id: 'qwen3-plus', label: 'Qwen3 Plus', speed: 'Fast · balanced', contextWindow: 128_000 },
      { id: 'qwen-max', label: 'Qwen Max', speed: 'Powerful · general', contextWindow: 32_768 },
      { id: 'qwen-plus', label: 'Qwen Plus', speed: 'Fast · general', contextWindow: 128_000 },
      { id: 'qwen-turbo', label: 'Qwen Turbo', speed: 'Fastest · cheap', contextWindow: 128_000 },
      { id: 'qwen-long', label: 'Qwen Long', speed: 'Long context · 1M', contextWindow: 1_000_000 },
      { id: 'qwen2.5-coder-32b-instruct', label: 'Qwen 2.5 Coder 32B', speed: 'Powerful · code', contextWindow: 128_000 },
      { id: 'qwen2.5-72b-instruct', label: 'Qwen 2.5 72B', speed: 'Powerful · general', contextWindow: 128_000 },
    ],
  },
  {
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.io/v1',
    envKey: 'MINIMAX_API_KEY',
    signupUrl: 'https://platform.minimax.io/',
    models: [
      { id: 'MiniMax-Text-01', label: 'MiniMax Text-01', speed: 'Powerful · 4M context', contextWindow: 4_000_000 },
      { id: 'MiniMax-M2.5', label: 'MiniMax M2.5', speed: 'Reasoning · flagship', contextWindow: 1_000_000 },
      { id: 'MiniMax-M2.7', label: 'MiniMax M2.7', speed: 'Fast · agentic', contextWindow: 1_000_000 },
      { id: 'MiniMax-M3', label: 'MiniMax M3', speed: 'Powerful · agentic', contextWindow: 1_000_000 },
      { id: 'MiniMax-M2', label: 'MiniMax M2', speed: 'Fast · high speed', contextWindow: 128_000 },
      { id: 'abab6.5s-chat', label: 'MiniMax Abab 6.5s', speed: 'Fast · chat', contextWindow: 245_760 },
    ],
  },
  {
    name: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.ai/v1',
    envKey: 'MOONSHOT_API_KEY',
    signupUrl: 'https://platform.moonshot.cn/',
    models: [
      { id: 'kimi-k3', label: 'Kimi K3', speed: 'Powerful · agentic', contextWindow: 256_000 },
      { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', speed: 'Coding', contextWindow: 256_000 },
      { id: 'kimi-k2.7-code-highspeed', label: 'Kimi K2.7 Code Highspeed', speed: 'Fast · coding', contextWindow: 256_000 },
      { id: 'kimi-k2.6', label: 'Kimi K2.6', speed: 'Balanced', contextWindow: 256_000 },
    ],
  },
  {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    signupUrl: 'https://console.groq.com/keys',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', speed: 'Ultra-fast · 128k', contextWindow: 128_000 },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B', speed: 'Instant · 128k', contextWindow: 128_000 },
      { id: 'deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 70B', speed: 'Ultra-fast reasoning', contextWindow: 128_000 },
      { id: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B', speed: 'Fast · MoE', contextWindow: 32_768 },
    ],
  },
  {
    name: 'StepFun',
    baseUrl: 'https://api.stepfun.com/v1',
    envKey: 'STEPFUN_API_KEY',
    signupUrl: 'https://platform.stepfun.com/',
    models: [
      { id: 'step-2-16k', label: 'Step-2 16K', speed: 'Powerful · flagship', contextWindow: 16_384 },
      { id: 'step-1-8k', label: 'Step-1 8K', speed: 'Fast · balanced', contextWindow: 8_192 },
      { id: 'step-1-flash', label: 'Step-1 Flash', speed: 'Fastest · cheap', contextWindow: 8_192 },
    ],
  },
  {
    name: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    envKey: 'FIREWORKS_API_KEY',
    signupUrl: 'https://fireworks.ai/api-keys',
    models: [
      { id: 'accounts/fireworks/models/deepseek-r1', label: 'DeepSeek R1', speed: 'Reasoning · fast', contextWindow: 160_000 },
      { id: 'accounts/fireworks/models/deepseek-v3', label: 'DeepSeek V3', speed: 'Powerful · fast', contextWindow: 160_000 },
      { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', label: 'Llama 3.3 70B', speed: 'Balanced · 128k', contextWindow: 128_000 },
    ],
  },
  {
    name: 'BytePlus ModelArk',
    baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    envKey: 'ARK_API_KEY',
    signupUrl: 'https://console.byteplus.com/ark/',
    models: [
      { id: 'deepseek-v4-flash-ga-260731', label: 'DeepSeek V4 Flash GA', speed: 'Fast · GA build', contextWindow: 128_000 },
      { id: 'deepseek-v4-pro-ga-260813', label: 'DeepSeek V4 Pro GA', speed: 'Powerful · GA build', contextWindow: 128_000 },
    ],
  },
  {
    name: 'FPT Cloud AI',
    baseUrl: 'https://mkp-api.fptcloud.com/v1',
    envKey: 'FPT_API_KEY',
    signupUrl: 'https://fptcloud.com/',
    models: [
      { id: 'DeepSeek-V4-Flash', label: 'DeepSeek V4 Flash', speed: 'Fast · marketplace', contextWindow: 64_000 },
      { id: 'GLM-5.2', label: 'GLM-5.2', speed: 'Powerful · marketplace', contextWindow: 64_000 },
      { id: 'Qwen2.5-Coder-32B-Instruct', label: 'Qwen 2.5 Coder 32B', speed: 'Code · marketplace', contextWindow: 32_768 },
    ],
  },
  {
    name: 'Upstage',
    baseUrl: 'https://api.upstage.ai/v1',
    envKey: 'UPSTAGE_API_KEY',
    signupUrl: 'https://console.upstage.ai/',
    models: [
      { id: 'solar-pro', label: 'Solar Pro', speed: 'Powerful · 64k', contextWindow: 64_000 },
      { id: 'solar-mini', label: 'Solar Mini', speed: 'Fast · cheap', contextWindow: 32_768 },
    ],
  },
  {
    name: 'Arcee AI',
    baseUrl: 'https://conductor.arcee.ai/v1',
    envKey: 'ARCEE_API_KEY',
    signupUrl: 'https://app.arcee.ai/',
    models: [
      { id: 'trinity-large-preview', label: 'Trinity Large Preview', speed: 'Powerful · agentic', contextWindow: 128_000 },
      { id: 'arcee-spark', label: 'Arcee Spark', speed: 'Fast · compact', contextWindow: 32_768 },
    ],
  },
  {
    name: 'Tencent TokenHub',
    baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    envKey: 'TENCENT_API_KEY',
    signupUrl: 'https://cloud.tencent.com/',
    models: [
      { id: 'hunyuan-large', label: 'Hunyuan Large', speed: 'Powerful · MoE', contextWindow: 32_768 },
      { id: 'hunyuan-standard', label: 'Hunyuan Standard', speed: 'Balanced · 32k', contextWindow: 32_768 },
    ],
  },
  {
    name: 'GMI Cloud',
    baseUrl: 'https://api.gmi-serving.com/v1',
    envKey: 'GMI_API_KEY',
    signupUrl: 'https://gmicloud.ai/',
    models: [
      { id: 'deepseek-ai/deepseek-r1', label: 'DeepSeek R1', speed: 'Reasoning · direct', contextWindow: 64_000 },
      { id: 'deepseek-ai/deepseek-v3', label: 'DeepSeek V3', speed: 'Powerful · direct', contextWindow: 64_000 },
    ],
  },
  {
    name: 'Kilo Code',
    baseUrl: 'https://api.kilocode.ai/api/openrouter',
    envKey: 'KILOCODE_API_KEY',
    signupUrl: 'https://kilocode.ai/',
    // Kilo Code proxies OpenRouter, so ids are `kilocode/<vendor>/<model>` — the
    // full prefix is required here, otherwise `minimax/…` etc. would route to
    // the direct MiniMax provider instead. The `:free` list rotates on Kilo's
    // side; if one 402s ("add credits / switch to a free model") it was pulled,
    // pick another or run `:model` to see the live list.
    models: [
      { id: 'auto', label: 'Kilo Auto', speed: 'Auto-routed', contextWindow: 128_000 },
      { id: 'kilocode/minimax/minimax-m3:free', label: 'MiniMax M3 (free)', speed: 'Agentic · free · 1M', contextWindow: 1_048_576 },
      { id: 'kilocode/minimax/minimax-m2.7:free', label: 'MiniMax M2.7 (free)', speed: 'Fast agentic · free', contextWindow: 196_608 },
      { id: 'kilocode/nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra 550B (free)', speed: 'Powerful · free · 1M', contextWindow: 1_000_000 },
      { id: 'kilocode/nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super 120B (free)', speed: 'Powerful · free', contextWindow: 262_144 },
      { id: 'kilocode/nvidia/nemotron-3.5-lightning:free', label: 'Nemotron 3.5 Lightning (free)', speed: 'Fast · free · 1M', contextWindow: 1_000_000 },
      { id: 'kilocode/cohere/north-mini-code:free', label: 'North Mini Code (free)', speed: 'Code · free', contextWindow: 256_000 },
      { id: 'kilocode/stepfun/step-3.7-flash:free', label: 'Step 3.7 Flash (free)', speed: 'Fast · free', contextWindow: 262_144 },
      { id: 'kilocode/thinkingmachines/inkling:free', label: 'Inkling (free)', speed: 'Reasoning · free · 1M', contextWindow: 1_048_576 },
    ],
  },
  {
    name: 'Alibaba Cloud Coding Plan',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    envKey: 'ALIBABA_API_KEY',
    signupUrl: 'https://alibabacloud.com/',
    models: [
      { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus (Alibaba Plan)', speed: 'Powerful · Coding Tier', contextWindow: 128_000 },
      { id: 'qwen-max', label: 'Qwen Max (Alibaba Plan)', speed: 'Powerful · Coding Tier', contextWindow: 32_768 },
    ],
  },
  {
    name: 'Hugging Face',
    baseUrl: 'https://router.huggingface.co/v1',
    envKey: 'HUGGINGFACE_API_KEY',
    signupUrl: 'https://huggingface.co/settings/tokens',
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B', speed: 'Open · 128k', contextWindow: 128_000 },
      { id: 'deepseek-ai/DeepSeek-R1', label: 'DeepSeek R1', speed: 'Reasoning · open', contextWindow: 128_000 },
      { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', label: 'Qwen 2.5 Coder 32B', speed: 'Code · open', contextWindow: 32_768 },
    ],
  },
  {
    name: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    envKey: 'MISTRAL_API_KEY',
    signupUrl: 'https://console.mistral.ai/',
    models: [
      { id: 'codestral-latest', label: 'Codestral Latest', speed: 'Code · fast', contextWindow: 256_000 },
      { id: 'mistral-large-latest', label: 'Mistral Large Latest', speed: 'Powerful · flagship', contextWindow: 128_000 },
      { id: 'mistral-small-latest', label: 'Mistral Small Latest', speed: 'Fast · cheap', contextWindow: 128_000 },
      { id: 'open-mistral-nemo', label: 'Mistral Nemo', speed: 'Fast · compact', contextWindow: 128_000 },
    ],
  },
  {
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    envKey: 'TOGETHER_API_KEY',
    signupUrl: 'https://api.together.ai/',
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo', speed: 'Fast · 128k', contextWindow: 128_000 },
      { id: 'deepseek-ai/DeepSeek-R1', label: 'DeepSeek R1 (Together)', speed: 'Reasoning · fast', contextWindow: 128_000 },
      { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', label: 'Qwen 2.5 Coder 32B', speed: 'Code · 32k', contextWindow: 32_768 },
    ],
  },
  {
    name: 'Cohere',
    baseUrl: 'https://api.cohere.com/v2',
    envKey: 'COHERE_API_KEY',
    signupUrl: 'https://dashboard.cohere.com/',
    models: [
      { id: 'command-r-plus-08-2024', label: 'Command R+ 08-2024', speed: 'Powerful · 128k', contextWindow: 128_000 },
      { id: 'command-r-08-2024', label: 'Command R 08-2024', speed: 'Fast · 128k', contextWindow: 128_000 },
    ],
  },
  {
    name: 'Ollama (local, free)',
    baseUrl: 'http://localhost:11434/v1',
    envKey: null, // No API key needed
    signupUrl: 'https://ollama.com',
    models: [], // Auto-detect from running Ollama instance
  },
  {
    name: 'Custom endpoint',
    baseUrl: '', // User provides
    envKey: null,
    signupUrl: '',
    models: [], // User provides model ID
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find a provider entry by display name (case-insensitive).
 */
export function findProviderByName(name: string): ProviderEntry | undefined {
  return PROVIDER_REGISTRY.find(p => p.name.toLowerCase() === name.toLowerCase());
}

/**
 * Detect an existing API key for a provider.
 * Checks process.env first, then the global config file.
 */
export function detectExistingKey(provider: ProviderEntry): string | null {
  if (!provider.envKey) return null;

  // 1. Check process.env (canonical + lowercase)
  const envVal = getApiKey(provider.envKey);
  if (envVal) return envVal;

  // 2. Check saved config
  const cfg = loadGlobalConfig();
  if (cfg && cfg.apiKeyEnv === provider.envKey) {
    // The global config stores the env var name, not the key itself.
    // But the provider wizard saves the key to config.json as well.
    // Check if there's a saved key via any saved config mechanism.
    return null;
  }

  return null;
}

/**
 * Get the signup URL for a provider (for display when the user needs a key).
 */
export function getSignupUrl(provider: ProviderEntry): string {
  return provider.signupUrl;
}

/**
 * Mask an API key for safe display — show first 4 + last 4 characters.
 * Keys shorter than 10 chars just show '****'.
 */
export function maskApiKey(key: string): string {
  if (key.length < 10) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}
