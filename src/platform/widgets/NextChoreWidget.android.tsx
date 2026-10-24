import { Column, Text } from '@expo/ui/jetpack-compose';
import { createWidget } from 'expo-widgets';

interface NextChoreWidgetProps {
  firstChore: string;
  secondChore: string;
  thirdChore: string;
  remainingCount: number;
  updatedAt: string;
}

function NextChoreWidget(props: NextChoreWidgetProps) {
  'widget';

  return (
    <Column>
      <Text>今日の家事</Text>
      <Text>{props.firstChore ? `□ ${props.firstChore}` : '予定はありません'}</Text>
      {props.secondChore ? <Text>{`□ ${props.secondChore}`}</Text> : null}
      {props.thirdChore ? <Text>{`□ ${props.thirdChore}`}</Text> : null}
      {props.remainingCount > 0 ? <Text>{`ほか${props.remainingCount}件`}</Text> : null}
    </Column>
  );
}

export default createWidget('NextChoreWidget', NextChoreWidget, {
  firstChore: '',
  secondChore: '',
  thirdChore: '',
  remainingCount: 0,
  updatedAt: '',
});
