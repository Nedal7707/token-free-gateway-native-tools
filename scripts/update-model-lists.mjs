// Updates all provider model lists to current model IDs (from live catalogs),
// syncing index.ts definitions AND client.ts config.models + defaultModel.
import { readFileSync, writeFileSync } from "node:fs";

const REPLACEMENTS = [
  {
    file: "src/providers/chatgpt/index.ts",
    models: [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
      { id: "gpt-5.5", name: "GPT-5.5" },
      { id: "gpt-5.4", name: "GPT-5.4" },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      { id: "gpt-5.2", name: "GPT-5.2" },
      { id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
      { id: "gpt-5", name: "GPT-5" },
    ],
  },
  {
    file: "src/providers/chatgpt/client.ts",
    models: [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
      { id: "gpt-5.5", name: "GPT-5.5" },
      { id: "gpt-5.4", name: "GPT-5.4" },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      { id: "gpt-5.2", name: "GPT-5.2" },
      { id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
      { id: "gpt-5", name: "GPT-5" },
    ],
    defaultModel: "gpt-5.6-luna",
  },
  {
    file: "src/providers/claude/index.ts",
    models: [
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { id: "claude-haiku-4-6", name: "Claude Haiku 4.6" },
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ],
  },
  {
    file: "src/providers/claude/client.ts",
    models: [
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { id: "claude-haiku-4-6", name: "Claude Haiku 4.6" },
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ],
    defaultModel: "claude-sonnet-4-6",
  },
  {
    file: "src/providers/gemini/index.ts",
    models: [
      { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
      { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash" },
      { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
      { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
      { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    ],
  },
  {
    file: "src/providers/gemini/client.ts",
    models: [
      { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
      { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash" },
      { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
      { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
      { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    ],
    defaultModel: "gemini-3.7-flash",
  },
  {
    file: "src/providers/glm/index.ts",
    models: [
      { id: "glm-5.2", name: "GLM-5.2" },
      { id: "glm-5.1", name: "GLM-5.1" },
      { id: "glm-5", name: "GLM-5" },
      { id: "glm-4.7-flash", name: "GLM-4.7 Flash" },
    ],
  },
  {
    file: "src/providers/glm/client.ts",
    models: [
      { id: "glm-5.2", name: "GLM-5.2" },
      { id: "glm-5.1", name: "GLM-5.1" },
      { id: "glm-5", name: "GLM-5" },
      { id: "glm-4.7-flash", name: "GLM-4.7 Flash" },
    ],
    defaultModel: "glm-5.2",
  },
  {
    file: "src/providers/glm-intl/index.ts",
    models: [
      { id: "glm-5.2", name: "GLM-5.2" },
      { id: "glm-4.7-flash", name: "GLM-4.7 Flash" },
    ],
  },
  {
    file: "src/providers/glm-intl/client.ts",
    models: [
      { id: "glm-5.2", name: "GLM-5.2" },
      { id: "glm-4.7-flash", name: "GLM-4.7 Flash" },
    ],
    defaultModel: "glm-5.2",
  },
  {
    file: "src/providers/deepseek/index.ts",
    models: [
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    ],
  },
  {
    file: "src/providers/deepseek/client.ts",
    models: [
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    ],
    defaultModel: "deepseek-v4-flash",
  },
  {
    file: "src/providers/kimi/index.ts",
    models: [
      { id: "kimi-k3", name: "Kimi K3" },
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
      { id: "kimi-k2.6", name: "Kimi K2.6" },
      { id: "kimi-k2.5", name: "Kimi K2.5" },
    ],
  },
  {
    file: "src/providers/kimi/client.ts",
    models: [
      { id: "kimi-k3", name: "Kimi K3" },
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
      { id: "kimi-k2.6", name: "Kimi K2.6" },
      { id: "kimi-k2.5", name: "Kimi K2.5" },
    ],
    defaultModel: "kimi-k3",
  },
  {
    file: "src/providers/grok/index.ts",
    models: [
      { id: "grok-4.6", name: "Grok 4.6" },
      { id: "grok-4.5", name: "Grok 4.5" },
    ],
  },
  {
    file: "src/providers/grok/client.ts",
    models: [
      { id: "grok-4.6", name: "Grok 4.6" },
      { id: "grok-4.5", name: "Grok 4.5" },
    ],
    defaultModel: "grok-4.6",
  },
  {
    file: "src/providers/qwen/index.ts",
    models: [
      { id: "qwen3.6-plus", name: "Qwen 3.6 Plus" },
      { id: "qwen3.7-max", name: "Qwen 3.7 Max" },
      { id: "qwen3.5-plus", name: "Qwen 3.5 Plus" },
    ],
  },
  {
    file: "src/providers/qwen/client.ts",
    models: [
      { id: "qwen3.6-plus", name: "Qwen 3.6 Plus" },
      { id: "qwen3.7-max", name: "Qwen 3.7 Max" },
      { id: "qwen3.5-plus", name: "Qwen 3.5 Plus" },
    ],
    defaultModel: "qwen3.6-plus",
  },
  {
    file: "src/providers/qwen-cn/index.ts",
    models: [
      { id: "qwen3.6-plus", name: "Qwen 3.6 Plus (CN)" },
      { id: "qwen3.7-max", name: "Qwen 3.7 Max (CN)" },
    ],
  },
  {
    file: "src/providers/qwen-cn/client.ts",
    models: [
      { id: "qwen3.6-plus", name: "Qwen 3.6 Plus (CN)" },
      { id: "qwen3.7-max", name: "Qwen 3.7 Max (CN)" },
    ],
    defaultModel: "qwen3.6-plus",
  },
  {
    file: "src/providers/xiaomimo/index.ts",
    models: [{ id: "mimo-v2.5", name: "MiMo V2.5" }],
  },
  {
    file: "src/providers/xiaomimo/client.ts",
    models: [{ id: "mimo-v2.5", name: "MiMo V2.5" }],
    defaultModel: "mimo-v2.5",
  },
];

function renderModels(models) {
  return models.map((m) => `\t\t{ id: "${m.id}", name: "${m.name}" }`).join(",\n");
}

function renderIndexModels(models) {
  return models.map((m) => `\t\t{ id: "${m.id}", name: "${m.name}" }`).join(",\n");
}

let failures = 0;
for (const r of REPLACEMENTS) {
  const p = r.file;
  try {
    let src = readFileSync(p, "utf8");
    // Replace the models array between "models: [" and the matching "]"
    const start = src.indexOf("models: [");
    if (start === -1) throw new Error("models: [ not found");
    // find the closing bracket of this array (first "]" after start that ends the array)
    const bracket = src.indexOf("]", start);
    if (bracket === -1) throw new Error("closing ] not found");
    const newArr = `models: [\n${renderIndexModels(r.models)}\n\t]`;
    src = src.slice(0, start) + newArr + src.slice(bracket + 1);

    if (r.defaultModel) {
      const dm = src.match(/defaultModel:\s*"[^"]*"/);
      if (dm) src = src.replace(dm[0], `defaultModel: "${r.defaultModel}"`);
    }
    writeFileSync(p, src);
    console.log(`OK ${r.file} (${r.models.length} models${r.defaultModel ? `, default=${r.defaultModel}` : ""})`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${r.file}: ${e.message}`);
  }
}
process.exit(failures ? 1 : 0);
