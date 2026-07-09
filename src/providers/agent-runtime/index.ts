import { livekitRuntime } from "./livekit.js";
import type { AgentRuntime } from "./types.js";

/**
 * Central runtime selection — same pattern as providers/index.ts. When a
 * second runtime lands, switch on an env var here; routes stay unchanged.
 */
export const agentRuntime: AgentRuntime = livekitRuntime;

export type { AgentRuntime, DispatchMetadata } from "./types.js";
