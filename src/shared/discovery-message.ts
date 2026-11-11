import type { Message } from '@ag-ui/core';

// Message IDs survive history replay even when metadata does not.
export const discoveryMessagePrefix = 'opendots:discovery:';

/** The message that starts a discovery investigation. */
export function isDiscoveryMessage(
  message: Pick<Message, 'id' | 'role' | 'metadata'>,
): boolean {
  if (message.role !== 'user') return false;
  if (message.id.startsWith(discoveryMessagePrefix)) return true;
  const metadata = message.metadata;
  return (
    !!metadata &&
    typeof metadata === 'object' &&
    'opendotsSource' in metadata &&
    metadata.opendotsSource === 'discovery'
  );
}
