import { Text, VStack } from '@expo/ui/swift-ui';
import { createWidget } from 'expo-widgets';

interface NextChoreWidgetProps {
  choreId: string | null;
  choreName: string;
  dateLabel: string;
  assignmentLabel?: string;
  updatedAt: string;
}

function NextChoreWidget(props: NextChoreWidgetProps) {
  'widget';

  return (
    <VStack>
      <Text>次の家事</Text>
      <Text>{props.choreId ? props.choreName : 'アプリで予定を設定'}</Text>
      <Text>{props.dateLabel}</Text>
      {props.assignmentLabel ? <Text>{props.assignmentLabel}</Text> : null}
    </VStack>
  );
}

export default createWidget('NextChoreWidget', NextChoreWidget, {
  choreId: null,
  choreName: '',
  dateLabel: '予定はまだありません',
  assignmentLabel: '',
  updatedAt: '',
});
