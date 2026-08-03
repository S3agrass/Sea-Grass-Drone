import { describe, it, expect, vi, beforeEach } from 'vitest';

// subscribeMedia used to re-read the whole media table on every row change. A
// surfacing drone drains its upload backlog over minutes, so n inserted rows
// meant n complete re-downloads of a list that is at its largest exactly then.
// These tests pin the incremental behaviour that replaced it — and the two
// things incremental state can get wrong: drift after a reconnect, and rows
// belonging to another drone.

let handler;          // the postgres_changes callback subscribeMedia registers
let subscribeCb;      // the status callback passed to .subscribe()
let selectCalls;      // how many full reads happened
let rows;             // what a full read returns
let lastFilter;

const channel = {
  on: (_event, opts, cb) => {
    lastFilter = opts.filter;
    handler = cb;
    return channel;
  },
  subscribe: (cb) => {
    subscribeCb = cb;
    return channel;
  },
};

vi.mock('../lib/supabase', () => {
  const build = () => {
    const q = {
      select: () => q,
      order: () => q,
      eq: () => q,
      then: (resolve) => {
        selectCalls += 1;
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return q;
  };
  return {
    supabaseConfigured: true,
    supabase: {
      from: () => build(),
      channel: () => channel,
      removeChannel: () => {},
    },
  };
});

const { subscribeMedia } = await import('../lib/mediaStore');

const row = (id, capturedAt, droneId = 'drone-1') => ({
  id,
  drone_id: droneId,
  name: `${id}.jpg`,
  type: 'photo',
  size: 1,
  captured_at: capturedAt,
  storage_path: `p/${id}.jpg`,
  trigger: 'auto',
  context: {},
});

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  selectCalls = 0;
  rows = [row('a', '2026-01-01T00:00:00Z')];
  handler = null;
  subscribeCb = null;
  lastFilter = undefined;
});

describe('subscribeMedia', () => {
  it('reads once at mount, then applies changes without re-reading', async () => {
    const seen = [];
    subscribeMedia('drone-1', (items) => seen.push(items));
    await flush();
    expect(selectCalls).toBe(1);

    // A backlog drain: three inserts arriving one after another.
    handler({ eventType: 'INSERT', new: row('b', '2026-01-02T00:00:00Z') });
    handler({ eventType: 'INSERT', new: row('c', '2026-01-03T00:00:00Z') });
    handler({ eventType: 'INSERT', new: row('d', '2026-01-04T00:00:00Z') });

    // The whole point: still one read, not four.
    expect(selectCalls).toBe(1);
    expect(seen.at(-1).map((i) => i.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('keeps newest-first ordering when a row arrives out of order', async () => {
    const seen = [];
    subscribeMedia('drone-1', (items) => seen.push(items));
    await flush();

    handler({ eventType: 'INSERT', new: row('late', '2026-06-01T00:00:00Z') });
    handler({ eventType: 'INSERT', new: row('older', '2025-01-01T00:00:00Z') });

    expect(seen.at(-1).map((i) => i.id)).toEqual(['late', 'a', 'older']);
  });

  it('replaces rather than duplicates on update', async () => {
    const seen = [];
    subscribeMedia('drone-1', (items) => seen.push(items));
    await flush();

    handler({ eventType: 'UPDATE', new: { ...row('a', '2026-01-01T00:00:00Z'), name: 'renamed.jpg' } });

    const ids = seen.at(-1).map((i) => i.id);
    expect(ids).toEqual(['a']);
    expect(seen.at(-1)[0].name).toBe('renamed.jpg');
  });

  it('removes on delete, which carries only the primary key', async () => {
    const seen = [];
    subscribeMedia('drone-1', (items) => seen.push(items));
    await flush();

    // No `new`, and `old` has just the id — that is what Supabase sends unless
    // the table is REPLICA IDENTITY FULL.
    handler({ eventType: 'DELETE', old: { id: 'a' } });

    expect(seen.at(-1)).toEqual([]);
  });

  it('ignores a row belonging to another drone', async () => {
    const seen = [];
    subscribeMedia('drone-1', (items) => seen.push(items));
    await flush();
    const before = seen.length;

    handler({ eventType: 'INSERT', new: row('x', '2026-05-01T00:00:00Z', 'drone-2') });

    expect(seen.length).toBe(before); // nothing emitted
  });

  it('re-reads on (re)subscribe, so a dropped socket cannot leave it stale', async () => {
    subscribeMedia('drone-1', () => {});
    await flush();
    expect(selectCalls).toBe(1);

    // Reconnect: anything that changed while the socket was down produced no
    // event to apply, so the mirror has to be rebuilt.
    subscribeCb('SUBSCRIBED');
    await flush();
    expect(selectCalls).toBe(2);

    subscribeCb('CHANNEL_ERROR');
    await flush();
    expect(selectCalls).toBe(2); // only on SUBSCRIBED
  });

  it('filters server-side when a drone is selected, and not otherwise', async () => {
    subscribeMedia('drone-1', () => {});
    await flush();
    expect(lastFilter).toBe('drone_id=eq.drone-1');

    subscribeMedia(null, () => {});
    await flush();
    expect(lastFilter).toBeUndefined();
  });

  it('stops emitting after unsubscribe', async () => {
    const seen = [];
    const off = subscribeMedia('drone-1', (items) => seen.push(items));
    await flush();
    const before = seen.length;

    off();
    handler({ eventType: 'INSERT', new: row('after', '2026-07-01T00:00:00Z') });

    expect(seen.length).toBe(before);
  });
});
