import { listKeys } from "../src/auth/keys.js";
import { migrate, sql } from "../src/db/index.js";

await migrate();
const keys = await listKeys();

if (keys.length === 0) {
	console.log("No API keys yet. Mint one with:  pnpm key:mint <project>");
} else {
	console.log(`\n${keys.length} key(s):\n`);
	for (const k of keys) {
		const state = k.revoked_at ? "REVOKED" : "active";
		const flags = k.internal ? " [internal]" : "";
		console.log(
			`  ${k.prefix}…  ${k.project.padEnd(16)} ${state.padEnd(8)}${flags} last used: ${k.last_used_at ?? "never"}`,
		);
	}
	console.log();
}
await sql.end();
