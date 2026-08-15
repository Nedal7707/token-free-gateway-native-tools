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
		{ id: "gpt-4-turbo", name: "GPT-4 Turbo" },
		{ id: "gpt-4", name: "GPT-4" },
	],
	factory: (credentials) => new ChatGPTWebClient(credentials as ChatGPTWebAuth),
	loginFn: loginChatGPTWeb,
};
