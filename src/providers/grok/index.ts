import type { ProviderDefinition } from "../types.ts";
import { loginGrokWeb } from "./auth.ts";
import { GrokWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "grok-web",
	name: "Grok Web",
	models: [
		{ id: "grok-4.6", name: "Grok 4.6" },
		{ id: "grok-4.5", name: "Grok 4.5" }
	],
	factory: (credentials) => new GrokWebClient(credentials as any),
	loginFn: loginGrokWeb,
};
