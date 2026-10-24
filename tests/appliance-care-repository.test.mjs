import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, extname, resolve as resolvePath } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    let target;
    if (specifier.startsWith('@/')) {
      target = resolvePath(projectRoot, 'src', specifier.slice(2));
    } else if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
      target = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
    }
    if (target && !extname(target)) {
      for (const extension of ['.ts', '.tsx', '.js', '.mjs']) {
        if (existsSync(target + extension)) return nextResolve(pathToFileURL(target + extension).href, context);
      }
      const indexPath = resolvePath(target, 'index.ts');
      if (existsSync(indexPath)) return nextResolve(pathToFileURL(indexPath).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const repository = await import('../src/platform/storage/repository.ts');

function createDatabase() {
  const connection = new DatabaseSync(':memory:');
  const database = {
    async execAsync(sql) {
      connection.exec(sql);
    },
    async runAsync(sql, ...params) {
      return connection.prepare(sql).run(...params);
    },
    async getFirstAsync(sql, ...params) {
      return connection.prepare(sql).get(...params) ?? null;
    },
    async getAllAsync(sql, ...params) {
      return connection.prepare(sql).all(...params);
    },
    async withTransactionAsync(callback) {
      connection.exec('BEGIN');
      try {
        await callback();
        connection.exec('COMMIT');
      } catch (error) {
        connection.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { connection, database };
}

function task(name, intervalDays, evidenceUrl, step) {
  return {
    name,
    ...(intervalDays !== undefined ? { recommendedIntervalDays: intervalDays } : {}),
    ...(intervalDays === undefined ? { recommendedConditions: ['汚れが気になったとき'] } : {}),
    steps: [step],
    tools: ['やわらかい布'],
    safetyCautions: ['電源を切る'],
    estimatedMinutes: 5,
    evidence: [{ url: evidenceUrl, pageOrSection: 'お手入れ' }],
  };
}

function analysis(modelNumber, tasks, analyzedAt) {
  return {
    manufacturer: 'Dyson',
    model: modelNumber,
    tasks,
    analyzedAt,
    requiresUserReview: true,
  };
}

function product(productName, modelNumber) {
  return {
    manufacturer: 'Dyson',
    productName,
    modelNumber,
    category: '掃除機',
    officialProductUrl: 'https://www.dyson.co.jp/products/vacuum-cleaners',
    manualUrl: `https://www.dyson.co.jp/support/journey/${modelNumber}`,
  };
}

test('repository saves and retrieves appliance snapshots, separates no-cycle tasks, distinguishes same-category appliances, and preserves overrides and history on reanalysis', async () => {
  const { connection, database } = createDatabase();
  try {
    await repository.initializeLocalDatabase(database);
    const firstRunSnapshot = await repository.loadPlannerSnapshot(database, '2026-10-24');
    assert.equal(firstRunSnapshot.settings.setupCompleted, false);
    assert.equal(firstRunSnapshot.settings.notificationsEnabled, false);

    const originalTasks = [
      task('フィルター清掃', 30, 'https://www.dyson.co.jp/support/journey/SV20#filter', '旧手順'),
      task('汚れを確認', undefined, 'https://www.dyson.co.jp/support/journey/SV20#care', '条件時の手順'),
    ];
    const initial = await repository.saveReviewedApplianceCare(
      database,
      product('V12 Detect Slim', 'SV20'),
      analysis('SV20', originalTasks, '2026-10-24T00:00:00.000Z'),
      [
        { task: originalTasks[0], userIntervalDays: 60 },
        { task: originalTasks[1] },
      ],
    );

    assert.equal(initial.scheduledTaskCount, 1);
    assert.equal(initial.noCycleTaskCount, 1);
    const firstContext = await repository.loadApplianceCareReviewContext(database, initial.applianceId);
    assert.equal(firstContext.appliance.analysis.tasks.length, 2);
    assert.equal(firstContext.appliance.analysis.tasks[1].evidence[0].pageOrSection, 'お手入れ');
    assert.equal(firstContext.chores.length, 1);
    const firstChore = firstContext.chores[0];
    assert.equal(firstChore.userIntervalDays, 60);
    assert.equal(firstChore.manufacturerRecommendedIntervalDays, 30);
    assert.equal(firstChore.applianceCareSource.evidence[0].url, originalTasks[0].evidence[0].url);
    const changedIdentityTask = task('別製品の手入れ', 30, 'https://www.dyson.co.jp/support/journey/OTHER#care', '手順');
    await assert.rejects(repository.saveReviewedApplianceCare(
      database,
      { ...product('別製品', 'OTHER'), applianceId: initial.applianceId },
      analysis('OTHER', [changedIdentityTask], '2026-10-24T00:30:00.000Z'),
      [{ task: changedIdentityTask }],
    ), /再解析で変更できません/u);

    connection.prepare(`
      INSERT INTO chore_completions
      (id, household_id, chore_id, completed_at, source, schedule_entry_id, outcome)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('history-1', repository.LOCAL_HOUSEHOLD_ID, firstChore.id, '2026-10-20T10:00:00.000Z', 'inApp', 'entry-1', 'completed');

    const revisedTask = task('フィルター清掃', 30, 'https://www.dyson.co.jp/support/journey/SV20#filter-update', '新手順');
    await repository.saveReviewedApplianceCare(
      database,
      { ...product('V12 Detect Slim', 'SV20'), applianceId: initial.applianceId },
      analysis('SV20', [revisedTask], '2026-10-24T01:00:00.000Z'),
      [{ task: revisedTask }],
    );

    const revisedContext = await repository.loadApplianceCareReviewContext(database, initial.applianceId);
    assert.equal(revisedContext.appliance.analysis.tasks[0].steps[0], '新手順');
    assert.equal(revisedContext.appliance.analysis.tasks[0].evidence[0].url, revisedTask.evidence[0].url);
    assert.equal(revisedContext.chores.length, 1);
    assert.equal(revisedContext.chores[0].id, firstChore.id);
    assert.equal(revisedContext.chores[0].instructions[0], '新手順');
    assert.equal(revisedContext.chores[0].userIntervalDays, 60);
    assert.equal(revisedContext.chores[0].manufacturerRecommendedIntervalDays, 30);
    const snapshotAfterReanalysis = await repository.loadPlannerSnapshot(database, '2026-10-24');
    assert.equal(snapshotAfterReanalysis.completions.some((item) => item.id === 'history-1'), true);
    assert.equal(snapshotAfterReanalysis.chores.some((item) => item.name.includes('汚れを確認')), false);

    const secondTasks = [task('ブラシの点検', 14, 'https://www.dyson.co.jp/support/journey/OTHER#brush', '点検手順')];
    const second = await repository.saveReviewedApplianceCare(
      database,
      product('別の掃除機', 'OTHER'),
      analysis('OTHER', secondTasks, '2026-10-24T02:00:00.000Z'),
      [{ task: secondTasks[0] }],
    );
    assert.notEqual(second.applianceId, initial.applianceId);
    const secondContext = await repository.loadApplianceCareReviewContext(database, second.applianceId);
    assert.equal(secondContext.appliance.modelNumber, 'OTHER');
    assert.equal(secondContext.chores.length, 1);
    assert.notEqual(secondContext.chores[0].id, revisedContext.chores[0].id);
  } finally {
    connection.close();
  }
});
