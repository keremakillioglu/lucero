import { attachCachedResults, toolCallKey, turnReminder } from './suggest';

const call = {
  serverName: 'warehouse',
  toolName: 'query',
  arguments: { sql: 'select 1', limit: 5 },
};

describe('toolCallKey', () => {
  it('ignores argument key order, including nested objects', () => {
    expect(toolCallKey(call)).toBe(
      toolCallKey({ ...call, arguments: { limit: 5, sql: 'select 1' } }),
    );
    expect(toolCallKey({ ...call, arguments: { a: { y: 1, x: 2 } } })).toBe(
      toolCallKey({ ...call, arguments: { a: { x: 2, y: 1 } } }),
    );
  });

  it('distinguishes different sources, tools and argument values', () => {
    const key = toolCallKey(call);
    expect(toolCallKey({ ...call, serverName: 'adjust-reports' })).not.toBe(key);
    expect(toolCallKey({ ...call, toolName: 'describe_table' })).not.toBe(key);
    expect(toolCallKey({ ...call, arguments: { sql: 'select 2', limit: 5 } })).not.toBe(key);
  });
});

describe('turnReminder', () => {
  it('stays silent until the last two turns, then demands the proposal', () => {
    expect(turnReminder(1, 10)).toBeNull();
    expect(turnReminder(8, 10)).toBeNull();
    expect(turnReminder(9, 10)).toMatch(/next turn must call propose_views/);
    expect(turnReminder(10, 10)).toMatch(/final turn: call propose_views now/);
  });
});

describe('attachCachedResults', () => {
  it('attaches the fetched result to views whose call matches, leaving the rest to run', () => {
    const results = new Map([[toolCallKey(call), '{"rows":[{"a":1}]}']]);
    const proposal = attachCachedResults(
      {
        notes: 'n',
        views: [
          { title: 'cached', display: 'line', ...call, arguments: { limit: 5, sql: 'select 1' } },
          { title: 'untested', display: 'bar', ...call, arguments: { sql: 'select 9' } },
        ],
      },
      results,
    );
    expect(proposal.notes).toBe('n');
    expect(proposal.views[0].result).toBe('{"rows":[{"a":1}]}');
    expect(proposal.views[1]).not.toHaveProperty('result');
  });
});
