import assert from 'node:assert/strict';
import test from 'node:test';

import { getSequenceBoard } from '../dist/orchestrator/pipeline/sequences-board.js';

const emptyDb = {
  prepare: () => ({ all: () => [] }),
};

test('a traditional sequencer board explains why it has no pipeline buckets', () => {
  const board = getSequenceBoard({
    db: emptyDb,
    config: {
      sequences: {
        default: { steps: [] },
        traditional: { steps: [{ id: 'email_1' }] },
      },
      pipeline: [],
    },
    sequence: 'traditional',
  });

  assert.deepEqual(board.buckets, []);
  assert.match(board.empty_reason || '', /traditional sequencer/i);
});
