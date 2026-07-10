import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * sync-worker-vendor — single-source the gateway↔worker boundary.
 *
 * The worker CANNOT import workspace packages: `lk agent deploy` builds its
 * Docker image from `worker/` alone (worker/Dockerfile `pnpm install`s before
 * the rest of the repo is copied). So the canonical shared code — HMAC signing,
 * slugify, and the AgentConfig/flow zod schema — is VENDORED: this script copies
 * packages/shared/src/*.ts verbatim into worker/src/vendor/, prepending a
 * DO-NOT-EDIT header. The worker imports ./vendor/*; worker/src/gateway.ts
 * derives its config types from the vendored schema via z.infer.
 *
 * Usage:
 *   pnpm sync:worker           copy (write) the vendored files
 *   pnpm sync:worker --check   verify no drift; exit 1 if a copy is stale
 *
 * Idempotent: running it twice with no source change writes nothing new.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const SRC_DIR = join(repoRoot, "packages", "shared", "src");
const OUT_DIR = join(repoRoot, "worker", "src", "vendor");

const HEADER = (basename: string) =>
	`// ============================================================================
// DO NOT EDIT — GENERATED FILE.
//
// Vendored verbatim from packages/shared/src/${basename} by \`pnpm sync:worker\`.
// The worker builds standalone (\`lk agent deploy\` uses worker/ as the entire
// Docker build context), so it can't import @voice-engine/shared. Edit the
// canonical file in packages/shared/src/ and re-run \`pnpm sync:worker\`.
// CI runs \`pnpm sync:worker --check\` to fail on drift.
// ============================================================================

`;

/** The generated content for a given shared source file. */
function render(basename: string): string {
	const source = readFileSync(join(SRC_DIR, basename), "utf8");
	return HEADER(basename) + source;
}

/** Shared .ts files to vendor (skip type-declaration/test files if any appear). */
function sharedFiles(): string[] {
	return readdirSync(SRC_DIR)
		.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.endsWith(".test.ts"))
		.sort();
}

const check = process.argv.includes("--check");
const files = sharedFiles();
const drifted: string[] = [];

if (!check && !existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

for (const basename of files) {
	const expected = render(basename);
	const outPath = join(OUT_DIR, basename);
	const current = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;

	if (check) {
		if (current !== expected) drifted.push(basename);
		continue;
	}

	if (current === expected) {
		console.log(`  = worker/src/vendor/${basename} (unchanged)`);
	} else {
		writeFileSync(outPath, expected);
		console.log(`  ✓ worker/src/vendor/${basename} (written)`);
	}
}

if (check) {
	if (drifted.length > 0) {
		console.error(
			`✗ worker vendor is out of sync (${drifted.join(", ")}).\n` +
				`  Run \`pnpm sync:worker\` to regenerate worker/src/vendor/ from packages/shared/src/.`,
		);
		process.exit(1);
	}
	console.log(`✓ worker vendor in sync (${files.length} file(s)).`);
} else {
	console.log(`Synced ${files.length} file(s) → worker/src/vendor/`);
}
