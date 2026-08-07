import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { recordsReevaluateCommand } from '../dist/commands/reevaluate.js';
import {
  ensureRecordColumns,
  insertFieldOverride,
  openListDb,
  reconcileFieldOverrides,
  upsertRecord,
} from '../dist/orchestrator/runtime/db.js';

const createList = () => {
  const listDir = mkdtempSync(join(tmpdir(), 'ao-reevaluate-'));
  writeFileSync(join(listDir, 'outbound.yaml'), `
source:
  near_duplicate:
    enabled: true
    name_similarity_threshold: 0.9
    signals:
      - name_and_address
      - name_and_domain
      - shared_phone
      - shared_domain
      - person_at_shared_address_or_domain
`);
  const db = openListDb({ listDir, readonly: false });
  ensureRecordColumns({
    db,
    columns: [
      { name: 'identity_confidence', type: 'REAL' },
      { name: 'lifecycle_stage', type: 'TEXT' },
      { name: 'account_sequence_state', type: 'TEXT' },
    ],
  });
  db.close();
  return listDir;
};

const seed = ({ listDir, row }) => {
  const db = openListDb({ listDir, readonly: false });
  try {
    upsertRecord({ db, row });
  } finally {
    db.close();
  }
};

const record = ({ listDir, rowId }) => {
  const db = openListDb({ listDir, readonly: true });
  try {
    return db.prepare('SELECT * FROM records WHERE _row_id = ?').get(rowId);
  } finally {
    db.close();
  }
};

test('records reevaluate dry run reports confidence and duplicate changes without writing', () => {
  const listDir = createList();
  try {
    seed({
      listDir,
      row: {
        _row_id: 'canonical',
        business_name: 'Example Services',
        address: '100 Main Street',
        phone: '+12085551212',
        phone_source_kind: 'structured',
        phone_confidence: 10,
      },
    });
    seed({
      listDir,
      row: {
        _row_id: 'duplicate',
        business_name: 'Example Services LLC',
        address: '100 Main Street',
        phone: '+12085551212',
        phone_source_kind: 'structured',
        phone_confidence: 10,
      },
    });

    const result = recordsReevaluateCommand({ list: listDir });

    assert.equal(result.status, 'dry_run');
    assert.equal(result.dry_run, true);
    assert.equal(result.matched, 2);
    assert.equal(result.fields.phone_confidence, 2);
    assert.equal(result.fields.duplicate_of, 1);
    assert.equal(result.duplicate_pairs.length, 1);
    assert.deepEqual(result.duplicate_pairs[0], {
      row_id: 'canonical',
      business_name: 'Example Services',
      matched_row_id: 'duplicate',
      matched_business_name: 'Example Services LLC',
      signals: ['name_and_address', 'shared_phone'],
      name_similarity: 1,
      reason: 'near_duplicate: name_and_address, shared_phone; name_similarity=1.00',
    });
    assert.equal(record({ listDir, rowId: 'canonical' }).phone_confidence, 10);
    assert.equal(record({ listDir, rowId: 'duplicate' }).duplicate_of, '');
  } finally {
    rmSync(listDir, { recursive: true, force: true });
  }
});

test('records reevaluate apply is idempotent', () => {
  const listDir = createList();
  try {
    seed({
      listDir,
      row: {
        _row_id: 'stale',
        business_name: 'Fresh Evidence',
        phone: '+12085551212',
        phone_confidence: 10,
      },
    });

    const applied = recordsReevaluateCommand({
      list: listDir,
      what: 'provenance,confidences',
      apply: true,
      declaredPhoneSourceKind: 'structured',
    });
    const repeated = recordsReevaluateCommand({
      list: listDir,
      what: 'provenance,confidences',
      apply: true,
      declaredPhoneSourceKind: 'structured',
    });

    assert.equal(applied.status, 'applied');
    assert.equal(applied.changed_records, 1);
    assert.equal(record({ listDir, rowId: 'stale' }).phone_source_kind, 'structured');
    assert.equal(record({ listDir, rowId: 'stale' }).phone_confidence, 85);
    assert.equal(repeated.changed_records, 0);
    assert.deepEqual(repeated.fields, {});
  } finally {
    rmSync(listDir, { recursive: true, force: true });
  }
});

test('records reevaluate does not modify terminal records or human-owned fields', () => {
  const listDir = createList();
  try {
    seed({
      listDir,
      row: {
        _row_id: 'terminal',
        business_name: 'Terminal Account',
        phone: '+12085551212',
        phone_source_kind: 'structured',
        phone_confidence: 10,
        suppressed: 1,
        suppressed_reason: 'operator',
        dnc_phone: 1,
        sequence_status: 'opted_out',
      },
    });
    seed({
      listDir,
      row: {
        _row_id: 'human-phone',
        business_name: 'Human Phone',
        phone: '+12085551212',
        phone_source_kind: 'structured',
        phone_confidence: 17,
      },
    });
    const db = openListDb({ listDir, readonly: false });
    try {
      insertFieldOverride({
        db,
        recordId: 'human-phone',
        field: 'phone_confidence',
        value: '17',
        reason: 'operator verified',
      });
      reconcileFieldOverrides({ db, recordIds: ['human-phone'] });
    } finally {
      db.close();
    }

    const result = recordsReevaluateCommand({ list: listDir, what: 'confidences', apply: true });
    const terminal = record({ listDir, rowId: 'terminal' });
    const human = record({ listDir, rowId: 'human-phone' });

    assert.equal(result.changed_records, 1);
    assert.equal(terminal.phone_confidence, 10);
    assert.equal(terminal.suppressed, 1);
    assert.equal(terminal.dnc_phone, 1);
    assert.equal(terminal.sequence_status, 'opted_out');
    assert.equal(human.phone_confidence, 17);
  } finally {
    rmSync(listDir, { recursive: true, force: true });
  }
});

test('records reevaluate updates records predating a derivation and leaves current records alone', () => {
  const listDir = createList();
  try {
    seed({
      listDir,
      row: {
        _row_id: 'predating-rule',
        business_name: 'Predating Rule',
        phone: '+12085551212',
        phone_source_kind: 'structured',
        phone_confidence: null,
      },
    });
    seed({
      listDir,
      row: {
        _row_id: 'already-current',
        business_name: 'Already Current',
        phone: '+12085551213',
        phone_source_kind: 'structured',
        identity_confidence: 0,
        phone_confidence: 85,
        buyer_confidence: 0,
        mail_confidence: 0,
      },
    });

    const result = recordsReevaluateCommand({ list: listDir, what: 'confidences' });
    const predating = result.records.find((item) => item.row_id === 'predating-rule');
    const current = result.records.find((item) => item.row_id === 'already-current');

    assert.ok(predating.changes.some((change) => change.field === 'phone_confidence' && change.to === 85));
    assert.deepEqual(current.changes, []);
  } finally {
    rmSync(listDir, { recursive: true, force: true });
  }
});
