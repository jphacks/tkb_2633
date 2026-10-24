import { Text, VStack } from '@expo/ui/swift-ui';
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
    <VStack>
      <Text>今日の家事</Text>
      {props.firstChore ? <Text>□ {props.firstChore}</Text> : <Text>予定はありません</Text>}
      {props.secondChore ? <Text>□ {props.secondChore}</Text> : null}
      {props.thirdChore ? <Text>□ {props.thirdChore}</Text> : null}
      {props.remainingCount > 0 ? <Text>ほか{props.remainingCount}件</Text> : null}
    </VStack>
  );
}

export default createWidget('NextChoreWidget', NextChoreWidget, {
  firstChore: '',
  secondChore: '',
  thirdChore: '',
  remainingCount: 0,
  updatedAt: '',
});
