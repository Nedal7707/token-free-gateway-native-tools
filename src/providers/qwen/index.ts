import type { ProviderDefinition } from "../types.ts";
import type { QwenWebAuth } from "./auth.ts";
import { loginQwenWeb } from "./auth.ts";
import { QwenWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "qwen-web",
	name: "Qwen Web",
	models: [
		{ id: "qwen3.6-plus", name: "Qwen 3.6 Plus" },
		{ id: "qwen3.7-max", name: "Qwen 3.7 Max" },
		{ id: "qwen3.5-plus", name: "Qwen 3.5 Plus" }
	],
	factory: (credentials) => new QwenWebClient(credentials as QwenWebAuth),
	loginFn: loginQwenWeb,
};
