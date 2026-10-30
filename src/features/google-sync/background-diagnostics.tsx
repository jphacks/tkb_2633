import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { openDatabaseAsync } from 'expo-sqlite';
import { AppButton, typography } from '../../components/planner-ui';
import type { BackgroundRun } from './background-audit';

export function BackgroundSyncDiagnostics() {
  const [rows, setRows] = useState<BackgroundRun[]>([]); const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    void (async () => {
      const database = await openDatabaseAsync('background-sync-audit.db', { useNewConnection: true });
      try {
        const table = await database.getFirstAsync("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_sync_runs'");
        const next = table ? await database.getAllAsync<BackgroundRun>('SELECT * FROM background_sync_runs ORDER BY id DESC LIMIT 5') : [];
        if (current) { setRows(next); setError(false); }
      } finally { await database.closeAsync(); }
    })().catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [revision]);
  return <>
    <Text style={typography.caption}>OSがバックグラウンド同期を実行した記録です。手動同期やアプリを開いた時の同期は含みません。実行時刻はOSが決めるため、60分ごとの実行を保証するものではありません。</Text>
    {error ? <Text accessibilityRole="alert" style={typography.body}>実行記録を読み込めませんでした。</Text> : rows.length ? rows.map(row => <Text key={row.id} style={typography.body}>
      {new Date(row.started_at).toLocaleString('ja-JP')}{row.release ? '・Release' : '・開発ビルド'}{'\n'}
      {row.outcome === 'success' ? '完了' : row.outcome === 'running' ? '実行中' : row.outcome === 'interrupted' ? '実行中に終了' : '一部を完了できませんでした'}
    </Text>) : <Text style={typography.body}>まだOSからの実行記録はありません。</Text>}
    <AppButton title="実行記録を再読込" variant="quiet" compact onPress={() => setRevision(value => value + 1)} />
  </>;
}
