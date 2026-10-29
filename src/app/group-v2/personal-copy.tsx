import { useCallback, useLayoutEffect, useRef } from 'react';
import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { AppButton, Card, Page, typography } from '../../components/planner-ui';
import { useWorkspace } from '../../hooks/use-workspace';
import { V2PersonalCopyScreen } from '../../features/sharing/v2-ui/personal-copy-screen';
import { createNativeV2PersonalCopy } from '../../platform/sharing/v2-personal-copy';

export default function V2PersonalCopyRoute() {
  const context = useWorkspace(); const router = useRouter(); const active = context.active?.protocol === 2 ? context.active : null;
  const current = useRef({ active, userId: context.userId });
  useLayoutEffect(() => { current.current = { active, userId: context.userId }; return () => { current.current = { active: null, userId: null }; }; }, [active, context.userId]);
  const load = useCallback(async () => {
    const assertAccess = async () => {
      const matches = () => active && current.current.active === active && current.current.userId === active.userId;
      if (!matches()) throw new Error('コピー先の共有グループが変わりました。');
      const record = await active!.record();
      if (!matches() || record.status !== 'active') throw new Error('コピー先の共有グループが変わりました。');
    };
    await assertAccess();
    return createNativeV2PersonalCopy({ repository: active!.session.repository, userId: active!.userId, groupId: active!.groupId, assertAccess });
  }, [active]);
  if (!context.ready || !active || context.userId !== active.userId) return <Page><Card><Text style={typography.body}>コピー先の共有グループを開いてください。</Text>
    <AppButton title="共有グループへ" onPress={() => router.replace('/sharing')} /></Card></Page>;
  return <V2PersonalCopyScreen key={`${active.userId}:${active.groupId}:${active.identity.deviceId}`} load={load}
    onBack={() => router.canGoBack() ? router.back() : router.replace('/group-v2')} />;
}
