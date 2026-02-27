import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const casesPath = path.join(rootDir, 'evals', 'cases.json');

function readCases() {
  const raw = fs.readFileSync(casesPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('cases.json 必须是数组');
  }
  return parsed;
}

function evaluate(cases) {
  const checks = [];

  checks.push({
    name: 'case_count>=40',
    pass: cases.length >= 40,
    detail: `实际数量=${cases.length}`,
  });

  const idSet = new Set();
  let duplicateCount = 0;
  for (const item of cases) {
    const id = typeof item?.id === 'string' ? item.id : '';
    if (!id) continue;
    if (idSet.has(id)) duplicateCount += 1;
    idSet.add(id);
  }
  checks.push({
    name: 'unique_case_id',
    pass: duplicateCount === 0,
    detail: `重复ID数量=${duplicateCount}`,
  });

  const requiredCategories = [
    'readonly_qa',
    'writeback_create',
    'writeback_delete',
    'clear_all',
    'reconnect_resume',
    'idempotency',
    'execution_profile',
    'dual_mode_shadow',
  ];

  const categoryCounter = new Map();
  for (const item of cases) {
    const category = typeof item?.category === 'string' ? item.category : 'unknown';
    categoryCounter.set(category, (categoryCounter.get(category) || 0) + 1);
  }

  for (const category of requiredCategories) {
    const count = categoryCounter.get(category) || 0;
    checks.push({
      name: `category:${category}`,
      pass: count > 0,
      detail: `数量=${count}`,
    });
  }

  const highRisk = cases.filter((c) => c?.risk === 'high').length;
  checks.push({
    name: 'high_risk_coverage>=10',
    pass: highRisk >= 10,
    detail: `高风险用例数量=${highRisk}`,
  });

  const passCount = checks.filter((c) => c.pass).length;
  const passRate = checks.length > 0 ? passCount / checks.length : 0;

  return {
    checks,
    passCount,
    totalChecks: checks.length,
    passRate,
    categoryCounter: Object.fromEntries(categoryCounter.entries()),
  };
}

function printReport(report) {
  console.log('=== Agent Eval Baseline ===');
  for (const check of report.checks) {
    const marker = check.pass ? 'PASS' : 'FAIL';
    console.log(`[${marker}] ${check.name} | ${check.detail}`);
  }
  console.log('');
  console.log(`pass_rate=${(report.passRate * 100).toFixed(2)}% (${report.passCount}/${report.totalChecks})`);
  console.log(`categories=${JSON.stringify(report.categoryCounter)}`);
}

function main() {
  const cases = readCases();
  const report = evaluate(cases);
  printReport(report);

  if (report.passCount !== report.totalChecks) {
    process.exitCode = 1;
  }
}

main();
