import { mintKey } from "../src/auth/keys.js";
import { migrate, sql } from "../src/db/index.js";

/**
 * Usage: pnpm key:mint <project> [--internal]
 * e.g.   pnpm key:mint cadence
 *        pnpm key:mint agent-worker --internal   (worker → /internal routes)
 */
const project = process.argv[2];
if (!project) {
	console.error("Usage: pnpm key:mint <project> [--internal]");
	process.exit(1);
}
const internal = process.argv.includes("--internal");

await migrate();
const { plaintext, record } = await mintKey(project, { internal });

console.log("\n✅ New API key minted\n");
console.log(`   project:  ${record.project}`);
console.log(`   prefix:   ${record.prefix}`);
console.log(`   internal: ${record.internal}`);
console.log(`   key:      ${plaintext}`);
console.log("\n⚠️  This is shown ONCE. Store it in the calling project's secrets now.\n");
console.log(`   Callers send:  Authorization: Bearer ${plaintext}\n`);
await sql.end();
