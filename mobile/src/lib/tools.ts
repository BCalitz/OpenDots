// Human-in-the-loop tools the app offers the Dot on every run. They mirror
// src/shared/page-review.ts and src/shared/connection-types.ts on the server;
// tests/mobile-tools.test.ts fails if the two drift apart.
export const connectionActionTool = {
  name: 'request_connection_action',
  description:
    'Ask the owner to approve a connected-service action that changes something (sends, creates, updates, deletes). Use only after a connection tool returned approval_required. Pass its approvalId and a one-sentence summary of the effect. Call once, then wait: the result contains the service response if approved.',
  parameters: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      approvalId: { type: 'string', minLength: 1, maxLength: 64 },
      summary: { type: 'string', minLength: 1, maxLength: 500 },
    },
    required: ['approvalId', 'summary'],
    additionalProperties: false,
  },
} as const;

export const pageReviewTool = {
  name: 'review_space_page',
  description:
    'Present a Markdown draft for human review before saving it into an authorized Space. The user can approve and save, or decline. Do not create the page yourself after this tool: its approved result includes the saved page URL. Call once, then wait for the review result.',
  parameters: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 160 },
      content: { type: 'string', minLength: 1, maxLength: 20000 },
      spaceId: { type: 'string', minLength: 1 },
    },
    required: ['title', 'content', 'spaceId'],
    additionalProperties: false,
  },
} as const;

export const frontendTools = [connectionActionTool, pageReviewTool].map(
  (tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }),
);

export type FrontendToolName =
  typeof connectionActionTool.name | typeof pageReviewTool.name;
export const isFrontendTool = (name: string): name is FrontendToolName =>
  name === connectionActionTool.name || name === pageReviewTool.name;
