import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditReportingDatabaseContract, summarizeReportingDatabaseAudit } from './reportingDatabaseContract.js';

const rootDir = process.cwd();
const schemaText = [
  fs.readFileSync(path.join(rootDir, 'cloudflare-v2/src/tenant-schema.generated.ts'), 'utf8'),
  fs.readFileSync(path.join(rootDir, 'cloudflare-v2/src/tenant-migrations.ts'), 'utf8')
].join('\n');

test('tenant database schema satisfies reporting source table and column contract', () => {
  const audit = auditReportingDatabaseContract(schemaText);
  const summary = summarizeReportingDatabaseAudit(audit);
  assert.equal(summary.ok, true, JSON.stringify(summary, null, 2));
});
