import type { ProviderDefinition } from "../types.ts";
import type { ChatGPTWebAuth } from "./auth.ts";
import { loginChatGPTWeb } from "./auth.ts";
import { ChatGPTWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "chatgpt-web",
	name: "ChatGPT Web",
	models: [
		{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
		{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
		{ id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
		{ id: "gpt-5.5", name: "GPT-5.5" },
		{ id: "gpt-5.4", name: "GPT-5.4" },
		{ id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
		{ id: "gpt-5.2", name: "GPT-5.2" },
		{ id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
		{ id: "gpt-5", name: "GPT-5" }
	],
	factory: (credentials) => new ChatGPTWebClient(credentials as ChatGPTWebAuth),
	loginFn: loginChatGPTWeb,
};
