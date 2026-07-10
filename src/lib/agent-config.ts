/**
 * AgentConfig — the neutral agent document (spec §4).
 *
 * The schema itself now lives in `@voice-engine/shared/agent-config` so it can
 * be single-sourced with the worker: the worker can't import workspace packages
 * (it builds standalone via `lk agent deploy`), so that canonical file is
 * VENDORED into worker/src/vendor/ by `pnpm sync:worker` and the worker derives
 * its config types from the vendored copy. Editing the shape is a one-place edit
 * in packages/shared/src/agent-config.ts followed by `pnpm sync:worker`.
 *
 * This module re-exports the schema so every existing gateway import
 * (`../lib/agent-config.js`) keeps working unchanged.
 */
export {
	AgentConfig,
	AgentConfigPatch,
	interpolate,
} from "@voice-engine/shared/agent-config";
export type {
	AgentConfigT,
	Flow,
	FlowNode,
	FlowScenario,
	FlowObjective,
} from "@voice-engine/shared/agent-config";
