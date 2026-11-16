import type { Tool } from './tools.js';

/** Failures of one tool in a row before the Dot is told to stop. */
export const STUCK_AFTER = 2;

const BLOCKED =
  'This tool has failed twice in a row. Do not call it again this turn. Tell the owner plainly what blocked you and what you got done, say what you could not do, and offer a way past it: another account or tool, doing it themselves, or trying again later. Do not present partial results as complete.';

/** Whether a tool result says the tool did not do its job. */
function failed(result: unknown) {
  if (!result || typeof result !== 'object') return false;
  const value = result as { isError?: unknown; status?: unknown };
  return value.isError === true || value.status === 'unavailable';
}

/**
 * Stops a Dot from looping on a tool that keeps failing, such as a login that
 * is refused or a service that is down. After STUCK_AFTER failures in a row
 * the tool answers with an instruction to stop and report instead of running
 * again, so the turn ends with what blocked it. A success starts the count
 * over. Counts are per turn: call this once for each turn's tools.
 * `onBlocked` hears of each tool that stopped, so the run can end as blocked.
 */
export function stopWhenStuck(
  tools: Tool[],
  onBlocked?: (tool: string) => void,
): Tool[] {
  const streak = new Map<string, number>();
  const block = (name: string) => {
    onBlocked?.(name);
    return { status: 'blocked', message: BLOCKED };
  };
  return tools.map((tool) => ({
    ...tool,
    execute: async (input, context) => {
      if ((streak.get(tool.name) ?? 0) >= STUCK_AFTER) return block(tool.name);
      let result: unknown;
      try {
        result = await tool.execute(input, context);
      } catch (error) {
        // An owner's stop is not a failure of the tool.
        if (context.signal.aborted) throw error;
        const count = (streak.get(tool.name) ?? 0) + 1;
        streak.set(tool.name, count);
        if (count >= STUCK_AFTER) return block(tool.name);
        throw error;
      }
      if (!failed(result)) {
        streak.delete(tool.name);
        return result;
      }
      const count = (streak.get(tool.name) ?? 0) + 1;
      streak.set(tool.name, count);
      if (count < STUCK_AFTER) return result;
      onBlocked?.(tool.name);
      return { ...(result as object), blocked: true, message: BLOCKED };
    },
  }));
}
