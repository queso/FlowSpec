import type { FlowSpec, FlowResult } from './types';

/**
 * Execute a flow specification and return the result
 * @param flow - The FlowSpec to execute
 * @returns Promise resolving to the FlowResult
 */
export async function runFlow(flow: FlowSpec): Promise<FlowResult> {
  throw new Error('Not implemented');
}
