# Example: Add a Feature — MCP Client & Multi-Provider Model List

**Scenario:** Aura Code v0.3.0 added an MCP (Model Context Protocol) client
for connecting to external tool servers, plus expanded provider support with
OpenRouter, Xiaomi MiMo, and xAI Grok.

## Command: List all supported models to verify the new providers

```bash
aura --models
```

## Real output (captured from aura-code v0.3.0):

```
Supported models:

  Anthropic
    claude-opus-4-5-20251001                      Powerful · strongest
    claude-sonnet-4-5-20251001                    Fast · balanced
    claude-haiku-4-5-20251001                     Fastest · cheap
    claude-3-5-sonnet-20241022                    Fast · legacy
    claude-3-5-haiku-20241022                     Fastest · legacy
    claude-3-opus-20240229                        Powerful · legacy
  OpenAI
    gpt-4o                                        Powerful · multimodal
    gpt-4o-mini                                   Fast · cheap
    gpt-4-turbo                                   Powerful · legacy
    gpt-3.5-turbo                                 Fastest · legacy
    o1                                            Reasoning · flagship
    o1-mini                                       Reasoning · cheap
    o1-preview                                    Reasoning · legacy
    o3                                            Reasoning · new flagship
    o3-mini                                       Reasoning · fast
    o4-mini                                       Reasoning · fastest
  Google
    gemini-2.5-pro                                Powerful · long context
    gemini-2.5-flash                              Fast · cheap
    gemini-2.0-pro                                Powerful
    gemini-2.0-flash                              Fast
    gemini-1.5-pro                                Long context · legacy
    gemini-1.5-flash                              Fast · legacy
    gemini-1.5-flash-8b                           Fastest · tiny
  Xiaomi MiMo
    mimo-v2.5-pro                                 Powerful · 1T params
    mimo-v2.5                                     Fast · 310B
    mimo-v2-flash                                 Fastest · efficient
    mimo-v1                                       Legacy
  xAI
    grok-2                                        Powerful
    grok-2-mini                                   Fast · cheap
    grok-beta                                     Fast
    grok-vision-beta                              Multimodal
  OpenRouter
    openrouter/anthropic/claude-3.5-sonnet        Fast
    openrouter/anthropic/claude-3-opus            Powerful
    openrouter/openai/gpt-4o                      Powerful
    openrouter/openai/o1                          Reasoning
    openrouter/google/gemini-2.0-flash-exp        Fast
    openrouter/meta-llama/llama-3.1-405b-instruct Open · powerful
    openrouter/meta-llama/llama-3.1-70b-instruct  Open · fast
    openrouter/meta-llama/llama-3.1-8b-instruct   Open · cheap
    openrouter/mistralai/mistral-large-latest     Powerful
    openrouter/mistralai/mixtral-8x7b-instruct    Open · fast
    openrouter/qwen/qwen-2.5-72b-instruct         Open · strong
    openrouter/qwen/qwen-2.5-coder-32b-instruct   Open · code
    openrouter/deepseek/deepseek-v4-flash:free       Fast · 1M context · free
    openrouter/deepseek/deepseek-r1               Reasoning · open
    openrouter/deepseek/deepseek-v4-pro           Powerful · 1M context
    openrouter/google/gemma-2-27b-it              Open · fast
    openrouter/nex-agi/nex-n2-pro:free            Free · open
  Ollama
    ollama/llama3.2                               Local · small
    ollama/llama3.1                               Local · 8B-70B
```

**Result:** 6 provider families supported (Anthropic, OpenAI, Google, Xiaomi MiMo,
xAI, OpenRouter) plus local Ollama — all verified via `aura --models`.
MCP client available via `aura "use my database" --mcp` (configure in `.aura.json`).
