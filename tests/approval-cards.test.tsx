import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
import { PageReviewCard } from '../src/client/PageReviewCard';
import { ConnectionActionCard } from '../src/client/ConnectionActionCard';
import type { ApprovalView } from '../src/shared/approvals';

const draft = { title: 'Brief', content: 'Evidence', spaceId: 'space' };
const approval = (
  kind: ApprovalView['kind'],
  payload: unknown,
  status: ApprovalView['status'] = 'pending',
): ApprovalView => ({
  id: 'approval-1',
  threadId: 'thread',
  toolCallId: 'call',
  kind,
  payload,
  status,
  createdAt: 1,
  decidedAt: null,
});
const text = (node: unknown): string =>
  typeof node === 'string'
    ? node
    : Array.isArray(node)
      ? node.map(text).join('')
      : node && typeof node === 'object' && 'children' in node
        ? text((node as { children: unknown }).children)
        : '';
const buttons = (root: ReturnType<typeof create>) =>
  root.root
    .findAll((node) => node.type === 'button')
    .map((node) => text(node.props.children));

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));

it('shows the server copy of a draft and sends the owner decision', async () => {
  const onDecide = vi.fn(async () => undefined);
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(
      createElement(PageReviewCard, {
        // The model's arguments differ; the server's record is what is shown.
        args: { ...draft, title: 'Model title' },
        approval: approval('page_review', draft),
        running: true,
        onDecide,
      }),
    );
  });
  expect(text(root.toJSON())).toContain('Ready for your review');
  expect(text(root.toJSON())).toContain('Brief');
  expect(text(root.toJSON())).not.toContain('Model title');
  expect(buttons(root)).toEqual(['Approve & save', 'Decline']);
  const approve = root.root.findAll(
    (node) =>
      node.type === 'button' && text(node.props.children).includes('Approve'),
  )[0];
  await act(async () => approve.props.onClick());
  expect(onDecide).toHaveBeenCalledWith('approval-1', true);
});

it('shows the saved page from the tool result and offers no decision', () => {
  const html = renderToStaticMarkup(
    <PageReviewCard
      args={draft}
      approval={approval('page_review', draft, 'approved')}
      result={JSON.stringify({
        approved: true,
        pageId: 'page',
        spaceId: 'space',
      })}
      running={false}
      onDecide={async () => {}}
    />,
  );
  expect(html).toContain('Saved to your Space');
  expect(html).toContain('Open page');
  expect(html).not.toContain('Decline');
});

it('never offers a decision once the turn has ended or the request closed', () => {
  for (const props of [
    { approval: approval('page_review', draft), running: false },
    { approval: approval('page_review', draft, 'expired'), running: true },
    { approval: undefined, running: false },
  ]) {
    const html = renderToStaticMarkup(
      <PageReviewCard args={draft} onDecide={async () => {}} {...props} />,
    );
    expect(html).not.toContain('Approve');
    expect(html).toContain('No page was saved.');
  }
  const declined = renderToStaticMarkup(
    <PageReviewCard
      args={draft}
      result={JSON.stringify({ approved: false, status: 'declined' })}
      approval={approval('page_review', draft, 'declined')}
      running={false}
      onDecide={async () => {}}
    />,
  );
  expect(declined).toContain('Declined');
});

it('renders a Markdown table in the draft as a table, not raw pipe text', () => {
  const content = '| Category | Score |\n| --- | --- |\n| Speed | 9 |';
  const html = renderToStaticMarkup(
    <PageReviewCard
      args={{ title: 'Brief', content, spaceId: 'space' }}
      running
      onDecide={async () => {}}
    />,
  );
  expect(html).toContain('<table>');
  expect(html).toContain('<th>Category</th>');
  expect(html).toContain('<td>Speed</td>');
  expect(html).not.toContain('| Category |');
});

it('shows the exact action from the server record and reports a decision error', async () => {
  const onDecide = vi.fn(async () => {
    throw new Error('This request is no longer waiting.');
  });
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(
      createElement(ConnectionActionCard, {
        args: {},
        approval: approval('connection_action', {
          connection: 'Mail',
          title: 'send mail',
          description: 'Send an email.',
          arguments: { to: 'a@example.com' },
        }),
        running: true,
        onDecide,
      }),
    );
  });
  const shown = text(root.toJSON());
  expect(shown).toContain('Mail · send mail');
  expect(shown).toContain('a@example.com');
  expect(shown).toContain('Needs your approval');
  const decline = root.root.findAll(
    (node) => node.type === 'button' && text(node.props.children) === 'Decline',
  )[0];
  await act(async () => decline.props.onClick());
  expect(onDecide).toHaveBeenCalledWith('approval-1', false);
  expect(text(root.toJSON())).toContain('This request is no longer waiting.');
});

it('shows a service response and keeps old summary-only cards readable', () => {
  const done = renderToStaticMarkup(
    <ConnectionActionCard
      args={{}}
      approval={approval('connection_action', {}, 'approved')}
      result={JSON.stringify({
        approved: true,
        isError: false,
        text: 'Sent to a@example.com',
      })}
      running={false}
      onDecide={async () => {}}
    />,
  );
  expect(done).toContain('Approved');
  expect(done).toContain('Sent to a@example.com');
  const legacy = renderToStaticMarkup(
    <ConnectionActionCard
      args={{ approvalId: 'old', summary: 'Send the weekly report' }}
      running={false}
      onDecide={async () => {}}
    />,
  );
  expect(legacy).toContain('Send the weekly report');
  expect(legacy).toContain('Nothing ran.');
});
