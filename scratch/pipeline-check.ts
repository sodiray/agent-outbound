import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inPlayWhere, openListDb, upsertRecord } from '../src/orchestrator/runtime/db.js';
import { runPipeline } from '../src/orchestrator/pipeline/runner.js';
import { collectDueRecords } from '../src/orchestrator/sequencer/runner.js';
import { evaluateFieldCheckGroup } from '../src/orchestrator/lib/conditions.js';

const listDir = join(process.cwd(), 'scratch', 'pipeline-check-list');
const sequencerListDir = join(process.cwd(), 'scratch', 'sequencer-check-list');
rmSync(listDir, { recursive: true, force: true });
rmSync(sequencerListDir, { recursive: true, force: true });
mkdirSync(listDir, { recursive: true });
mkdirSync(sequencerListDir, { recursive: true });

writeFileSync(join(listDir, 'outbound.yaml'), `
list:
  name: pipeline-check
source:
  identity: [business_name]
pipeline:
  - kind: filter
    id: require_website
    type: field_check
    match: all
    conditions:
      - { field: website, operator: is_not_empty }
    on_fail: drop
  - kind: filter
    id: require_treat_category
    type: field_check
    match: all
    conditions:
      - { field: vertical, operator: eq, value: treat }
    on_fail: drop
score:
  fit: { description: fit }
  trigger: { description: trigger }
ai:
  default_model: deepinfra/moonshotai/Kimi-K2.6
  defaults:
    evaluation: deepinfra/moonshotai/Kimi-K2.6
    copywriting: deepinfra/moonshotai/Kimi-K2.6
    research: deepinfra/moonshotai/Kimi-K2.6
sequences:
  default:
    steps: []
`);

const db = openListDb({ listDir, readonly: false });
upsertRecord({ db, row: { _row_id: 'keep', id: 'keep', business_name: 'Keep Co', website: 'https://keep.example', vertical: 'treat' } });
upsertRecord({ db, row: { _row_id: 'drop_no_site', id: 'drop_no_site', business_name: 'No Site Co', website: '', vertical: 'treat' } });
upsertRecord({ db, row: { _row_id: 'drop_wrong_category', id: 'drop_wrong_category', business_name: 'Wrong Co', website: 'https://wrong.example', vertical: 'other' } });
db.close();

const summary = await runPipeline({ listDir });
const checkDb = openListDb({ listDir, readonly: true });
const records = checkDb.prepare(`
  SELECT _row_id, disqualified_gate, disqualify_reason
  FROM records
  ORDER BY _row_id
`).all();
const inPlay = checkDb.prepare(`SELECT _row_id FROM records WHERE ${inPlayWhere()} ORDER BY _row_id`).all();
const events = checkDb.prepare(`
  SELECT record_id, step_id, passed, reason
  FROM pipeline_events
  ORDER BY occurred_at, step_id, record_id
`).all();
const step2RecordIds = events
  .filter((event: any) => event.step_id === 'require_treat_category')
  .map((event: any) => event.record_id)
  .sort();
checkDb.close();

writeFileSync(join(sequencerListDir, 'outbound.yaml'), `
list:
  name: sequencer-check
source:
  identity: [business_name]
sequences:
  default:
    steps: []
`);

const sequencerDb = openListDb({ listDir: sequencerListDir, readonly: false });
upsertRecord({
  db: sequencerDb,
  row: { _row_id: 'sequencer_keep', id: 'sequencer_keep', business_name: 'Sequencer Keep', sequence_status: 'idle' },
});
upsertRecord({
  db: sequencerDb,
  row: {
    _row_id: 'sequencer_drop',
    id: 'sequencer_drop',
    business_name: 'Sequencer Drop',
    sequence_status: 'idle',
    disqualified_at: new Date().toISOString(),
    disqualified_gate: 'test_gate',
    disqualify_reason: 'test disqualification',
  },
});
const sequencerDueIds = collectDueRecords({ db: sequencerDb })
  .map((row: any) => row._row_id)
  .sort();
sequencerDb.close();

const emptyAny = evaluateFieldCheckGroup({ row: { business_name: 'Empty Any' }, conditions: [], match: 'any' });
const emptyAll = evaluateFieldCheckGroup({ row: { business_name: 'Empty All' }, conditions: [], match: 'all' });

console.log(JSON.stringify({
  summary,
  records,
  in_play_ids: inPlay.map((row: any) => row._row_id),
  step2_record_ids: step2RecordIds,
  barrier_ok: !step2RecordIds.includes('drop_no_site'),
  sequencer_due_ids: sequencerDueIds,
  sequencer_disqualified_excluded: sequencerDueIds.length === 1 && sequencerDueIds[0] === 'sequencer_keep',
  empty_conditions: {
    any: emptyAny,
    all: emptyAll,
  },
  events,
}, null, 2));
