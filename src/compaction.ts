/**
 * compaction.ts — thin TS wrapper around the shared compaction module.
 * The module (./shared/compaction.mjs) holds the per-model context windows
 * and the compaction algorithm used by ALL services in the stack
 * (key-rotator, command-code bridge, token-free gateway), so every provider
 * compacts against the same table. Keep in sync with
 * C:\VectorHQ\shared-compaction\compaction.mjs (copy verbatim).
 */
// @ts-ignore - Bun resolves the .mjs sibling; tsc typecheck is lenient here.
import {
	compactMessages,
	compactRequest,
	contextWindowFor,
	estimateTokens,
} from "./shared/compaction.mjs";

export { compactMessages, compactRequest, contextWindowFor, estimateTokens };
