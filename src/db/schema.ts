import {
  pgTable,
  serial,
  text,
  timestamp,
  boolean,
  doublePrecision,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const contracts = pgTable('contracts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  endpoint: text('endpoint').notNull().unique(),
  method: text('method').default('POST').notNull(),
  schemaJson: text('schema_json').notNull(),
  mandatoryJson: text('mandatory_json').default('[]').notNull(),
  defaultsJson: text('defaults_json').default('{}').notNull(),
  historyJson: text('history_json').default('{}').notNull(),
  lastGoodJson: text('last_good_json'),
  lastGoodAt: timestamp('last_good_at'),
  enabled: boolean('enabled').default(true).notNull(),
  ownerUid: text('owner_uid'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const driftEvents = pgTable(
  'drift_events',
  {
    id: text('id').primaryKey(),
    contractId: text('contract_id')
      .notNull()
      .references(() => contracts.id, { onDelete: 'cascade' }),
    signature: text('signature').default('').notNull(),
    driftType: text('drift_type').default('NONE').notNull(),
    callsite: text('callsite'),
    classificationJson: text('classification_json').default('{}').notNull(),
    rawPayloadJson: text('raw_payload_json').default('{}').notNull(),
    healedPayloadJson: text('healed_payload_json'),
    planJson: text('plan_json'),
    gatesJson: text('gates_json'),
    status: text('status').default('PASSTHROUGH').notNull(),
    composer: text('composer').default('deterministic').notNull(),
    confidence: doublePrecision('confidence').default(1).notNull(),
    classifyMs: doublePrecision('classify_ms').default(0).notNull(),
    composeMs: doublePrecision('compose_ms').default(0).notNull(),
    gatesMs: doublePrecision('gates_ms').default(0).notNull(),
    totalMs: doublePrecision('total_ms').default(0).notNull(),
    canaryPassed: boolean('canary_passed'),
    prId: text('pr_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('drift_events_contract_created_idx').on(table.contractId, table.createdAt),
    index('drift_events_signature_idx').on(table.signature),
  ],
);

export const fingerprints = pgTable(
  'fingerprints',
  {
    id: text('id').primaryKey(),
    contractId: text('contract_id')
      .notNull()
      .references(() => contracts.id, { onDelete: 'cascade' }),
    signature: text('signature').notNull().unique(),
    planJson: text('plan_json').notNull(),
    opsSummary: text('ops_summary').default('').notNull(),
    hits: integer('hits').default(0).notNull(),
    confidence: doublePrecision('confidence').default(1).notNull(),
    ttlAt: timestamp('ttl_at').notNull(),
    status: text('status').default('ACTIVE').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at'),
  },
  (table) => [index('fingerprints_ttl_idx').on(table.ttlAt)],
);

export const pullRequests = pgTable(
  'pull_requests',
  {
    id: text('id').primaryKey(),
    contractId: text('contract_id')
      .notNull()
      .references(() => contracts.id, { onDelete: 'cascade' }),
    driftEventId: text('drift_event_id'),
    number: integer('number').notNull(),
    branch: text('branch').notNull(),
    title: text('title').notNull(),
    body: text('body').default('').notNull(),
    diffText: text('diff_text').default('').notNull(),
    planJson: text('plan_json').default('{}').notNull(),
    canaryLogJson: text('canary_log_json').default('[]').notNull(),
    status: text('status').default('OPEN').notNull(),
    mode: text('mode').default('DRY_RUN').notNull(),
    url: text('url'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [uniqueIndex('pull_requests_contract_number_idx').on(table.contractId, table.number)],
);

export const jobRuns = pgTable(
  'job_runs',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    status: text('status').default('QUEUED').notNull(),
    priority: integer('priority').default(5).notNull(),
    payloadJson: text('payload_json').default('{}').notNull(),
    resultJson: text('result_json'),
    ms: doublePrecision('ms'),
    attempts: integer('attempts').default(0).notNull(),
    error: text('error'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    finishedAt: timestamp('finished_at'),
  },
  (table) => [
    index('job_runs_status_created_idx').on(table.status, table.createdAt),
    index('job_runs_type_status_idx').on(table.type, table.status),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    category: text('category').default('SYSTEM').notNull(), // ALERT | SYSTEM | SETUP | DRIFT
    severity: text('severity').default('INFO').notNull(), // CRITICAL | WARNING | INFO | SUCCESS
    title: text('title').notNull(),
    description: text('description').default('').notNull(),
    source: text('source').default('runtime').notNull(),
    read: boolean('read').default(false).notNull(),
    metadataJson: text('metadata_json').default('{}').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('notifications_created_idx').on(table.createdAt)],
);
