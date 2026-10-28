import { useLocalSearchParams } from 'expo-router';
import { PrivateCalendarPairAuditScreen } from '@/features/sharing/development/private-calendar-pair-audit-screen';

export default function PrivateCalendarPairPreview() {
  const { host = '127.0.0.1', port = '8185', step = 'reference', reference, request, deviceId, attempt } = useLocalSearchParams<{
    host?: string; port?: string; step?: string; reference?: string; request?: string; deviceId?: string; attempt?: string;
  }>();
  return <PrivateCalendarPairAuditScreen key={[host, port, step, reference, request, deviceId, attempt].join('|')} host={host} port={port} step={step} reference={reference} request={request} deviceId={deviceId} />;
}
