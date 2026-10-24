import { Column, Text } from '@expo/ui/jetpack-compose';
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
    <Column>
      <Text>次の家事</Text>
      <Text>{props.choreId ? props.choreName : 'アプリで予定を設定'}</Text>
      <Text>{props.dateLabel}</Text>
      {props.assignmentLabel ? <Text>{props.assignmentLabel}</Text> : null}
    </Column>
  );
}

export default createWidget('NextChoreWidget', NextChoreWidget, {
  choreId: null,
  choreName: '',
  dateLabel: '予定はまだありません',
  assignmentLabel: '',
  updatedAt: '',
});
