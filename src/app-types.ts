import type { ApiKeyRecord } from "./auth/keys.js";

/** Hono context variables shared across middleware and routes. */
export interface AppEnv {
	Variables: {
		apiKey: ApiKeyRecord;
		requestId: string;
	};
}
