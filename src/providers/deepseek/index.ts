import type { ProviderDefinition } from "../types.ts";
import type { DeepSeekWebCredentials } from "./auth.ts";
import { loginDeepseekWeb } from "./auth.ts";
import { DeepSeekWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "deepseek-web",
	name: "DeepSeek Web",
	models: [
		{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
		{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }
	],
	factory: (credentials) => new DeepSeekWebClient(credentials as DeepSeekWebCredentials),
	loginFn: loginDeepseekWeb,
};
