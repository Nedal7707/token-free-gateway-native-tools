import type { ProviderDefinition } from "../types.ts";
import { loginDoubaoWeb } from "./auth.ts";
import { DoubaoWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "doubao-web",
	name: "Doubao Web",
	models: [
		{ id: "doubao-seed-2-0-pro", name: "Doubao Seed 2.0 Pro (Web)" },
		{ id: "doubao-seed-2-0-lite-260428", name: "Doubao Seed 2.0 Lite (Web)" },
		{ id: "doubao-seed-2-0-mini-260428", name: "Doubao Seed 2.0 Mini (Web)" },
	],
	factory: (credentials) => new DoubaoWebClient(credentials as any),
	loginFn: loginDoubaoWeb,
};
