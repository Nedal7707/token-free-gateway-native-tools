import type { ProviderDefinition } from "../types.ts";
import type { QwenCNWebAuth } from "./auth.ts";
import { loginQwenCNWeb } from "./auth.ts";
import { QwenCNWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "qwen-cn-web",
	name: "Qwen CN Web",
	models: [
		{ id: "qwen3.6-plus", name: "Qwen 3.6 Plus (CN)" },
		{ id: "qwen3.7-max", name: "Qwen 3.7 Max (CN)" }
	],
	factory: (credentials) => new QwenCNWebClient(credentials as QwenCNWebAuth),
	loginFn: loginQwenCNWeb,
};
