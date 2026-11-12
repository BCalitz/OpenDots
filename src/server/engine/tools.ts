import { toolDefinition, type JSONSchema } from '@tanstack/ai';
import type { BaseEvent } from '@ag-ui/core';
import type { z } from 'zod';

/** What a tool gets while it runs, besides its input. */
export interface ToolContext {
  toolCallId: string;
  signal: AbortSignal;
  /** Adds an event to the thread's stream, e.g. an approval request. */
  emit(event: BaseEvent): void;
  /**
   * Waits for `work` without counting the wait toward the turn's time
   * limit. For waits on the owner, such as an approval.
   */
  hold<T>(work: Promise<T>): Promise<T>;
}

/**
 * A server tool the model can call. Parameters are a zod schema (validated
 * before `execute` runs) or a JSON Schema from an outside service such as a
 * connected service, which validates it itself.
 */
export interface Tool {
  name: string;
  description: string;
  parameters: z.ZodType | JSONSchema;
  // Inputs are validated against `parameters` before this runs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute(input: any, context: ToolContext): unknown;
}

/** Defines a tool with a zod schema, typing `execute`'s input from it. */
export function defineTool<S extends z.ZodType>(tool: {
  name: string;
  description: string;
  parameters: S;
  execute(input: z.output<S>, context: ToolContext): unknown;
}): Tool {
  return tool;
}

/** Context for tools run outside a model turn, such as in tests. */
export function detachedContext(
  signal: AbortSignal = new AbortController().signal,
  toolCallId = 'detached',
): ToolContext {
  return { toolCallId, signal, emit: () => {}, hold: (work) => work };
}

/** Hands our tools to TanStack AI's `chat()`. */
export function toTanStackTools(
  tools: Tool[],
  run: Pick<ToolContext, 'signal' | 'emit' | 'hold'>,
) {
  const names = new Set<string>();
  return tools.map((tool) => {
    // The model API rejects duplicate names; fail early with a clear message.
    if (names.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    names.add(tool.name);
    return toolDefinition({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    }).server(async (input: unknown, context) =>
      tool.execute(input, {
        toolCallId: context?.toolCallId ?? tool.name,
        signal: context?.abortSignal
          ? AbortSignal.any([run.signal, context.abortSignal])
          : run.signal,
        emit: run.emit,
        hold: run.hold,
      }),
    );
  });
}
