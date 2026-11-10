import { expect, it } from 'vitest';
import { connectionActionTool as serverConnectionTool } from '../src/shared/connection-types.js';
import { pageReviewTool as serverPageReviewTool } from '../src/shared/page-review.js';
import {
  connectionActionTool,
  pageReviewTool,
} from '../mobile/src/lib/tools.js';

// The mobile app cannot import server code, so it carries its own copy of the
// human-in-the-loop tool definitions. They must match what the web app sends.
it('keeps the mobile app tool definitions in sync with the server', () => {
  expect(JSON.parse(JSON.stringify(connectionActionTool))).toEqual(
    JSON.parse(JSON.stringify(serverConnectionTool)),
  );
  expect(JSON.parse(JSON.stringify(pageReviewTool))).toEqual(
    JSON.parse(JSON.stringify(serverPageReviewTool)),
  );
});
