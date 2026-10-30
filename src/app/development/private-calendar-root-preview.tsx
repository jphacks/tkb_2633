import { useLocalSearchParams } from 'expo-router';
import { PrivateCalendarRootAuditScreen } from '@/features/sharing/development/private-calendar-root-audit-screen';

export default function PrivateCalendarRootPreview() {
  const { host = '127.0.0.1', port = '8185' } = useLocalSearchParams<{ host?: string; port?: string }>();
  return <PrivateCalendarRootAuditScreen host={host} port={port} />;
}
