import type { ProviderDefinition } from "../types.ts";
import { loginGlmWeb } from "./auth.ts";
import { GlmWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "glm-web",
	name: "ChatGLM (Web)",
	models: [
		{ id: "glm-5.3", name: "GLM-5.3" },
		{ id: "glm-5.2", name: "GLM-5.2" },
		{ id: "glm-5.1", name: "GLM-5.1" },
		{ id: "glm-5", name: "GLM-5" },
		{ id: "glm-4.7-flash", name: "GLM-4.7 Flash" }
	],
	factory: (credentials) => new GlmWebClient(credentials as any),
	loginFn: loginGlmWeb,
};
