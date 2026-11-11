import { z } from 'zod';

/**
 * A link on an approval request: a public http(s) address, or a page inside
 * OpenDots (`/#/...`). Anything else, such as `javascript:`, is refused.
 */
export function safeApprovalLink(url: string): boolean {
  if (url.startsWith('/#/')) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export const approvalRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(4000),
    /** The exact content produced for the owner: a draft reply, a message, a result. */
    output: z.string().trim().min(1).max(20000).optional(),
    link: z
      .object({
        url: z
          .string()
          .trim()
          .max(2000)
          .refine(
            safeApprovalLink,
            'Use an http(s) URL or an OpenDots /#/ link.',
          ),
        label: z.string().trim().min(1).max(120).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const approvalRequestTool = {
  name: 'request_approval',
  description:
    'Ask the owner to approve before you act on their behalf, or show them output you produced on their behalf (a draft reply, a message, a result) before it is used or sent. Shows a card in the chat with your title, a plain description of exactly what you will do, the exact output in `output` when there is one, and an optional link to what it concerns (a ticket, a draft, a page). Call it once and wait. If the result says approved, do exactly what you described with exactly that output, and nothing more. If it was declined or not answered, do not do it or try another way.',
};
