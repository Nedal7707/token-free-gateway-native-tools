import type { ProviderDefinition } from "../types.ts";
import { loginKimiWeb } from "./auth.ts";
import { KimiWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "kimi-web",
	name: "Kimi (Web)",
	models: [
		{ id: "kimi-k3", name: "Kimi K3" },
		{ id: "kimi-k2.7-code", name: "Kimi K2.7 Code" }
	],
	factory: (credentials) => new KimiWebClient(credentials as any),
	loginFn: loginKimiWeb,
};
