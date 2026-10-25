import { normalizeWasteTypeText, WASTE_TYPES } from './waste-types.ts';

// Stable by waste name, never by schedule id, recurrence, weekday, or list order.
// Dark colors keep names readable on the calendar's white background.
const typeColors: Readonly<Record<string, string>> = {
  '可燃ごみ': '#B85B13', '不燃ごみ': '#53617D', '資源ごみ': '#217B42', 'びん': '#08787C',
  '缶': '#265DB4', 'びん・缶': '#4F46A5', 'ペットボトル': '#087AA2', 'プラスチック資源': '#8953A0',
  '容器包装プラスチック': '#A04476', '製品プラスチック': '#5C50B6', '古紙': '#53752B', '新聞': '#27654E',
  '雑誌': '#85552E', '段ボール': '#916827', '紙パック': '#427F71', '雑がみ': '#666D36',
  '古布・衣類': '#9C4560', '小型家電': '#536CB0', '乾電池': '#957016', '充電池': '#A33C49',
  '蛍光灯': '#777024', '有害ごみ': '#984B2D', '危険ごみ': '#A83E32', 'スプレー缶': '#94536B',
  '金属類': '#4E6985', '粗大ごみ': '#744A91', '剪定枝': '#3E7942', '落ち葉・草': '#777934',
  '生ごみ': '#A45C3B', '陶磁器・ガラス': '#487785', '発泡スチロール': '#64739C', '使用済み食用油': '#857127',
};

function knownTypeIndex(label: string): number {
  const key = normalizeWasteTypeText(label);
  return WASTE_TYPES.findIndex((type) => [type.label, ...type.aliases]
    .some((term) => normalizeWasteTypeText(term) === key));
}

export function wasteTypeColor(label: string): string {
  const index = knownTypeIndex(label);
  if (index >= 0) return typeColors[WASTE_TYPES[index].label];
  const hash = [...normalizeWasteTypeText(label)].reduce((value, char) => (value * 31 + char.codePointAt(0)!) >>> 0, 0);
  return `hsl(${hash % 360}, 58%, 32%)`;
}

/** Compact names fit two readable lines in a seven-column mobile calendar. */
export function calendarWasteLabel(label: string): string {
  const index = knownTypeIndex(label);
  const canonical = index >= 0 ? WASTE_TYPES[index].label : label;
  const compact: Record<string, string> = {
    'プラスチック資源': 'プラ資源', '容器包装プラスチック': '容器プラ', '製品プラスチック': '製品プラ',
    '陶磁器・ガラス': '陶器・ガラス', '発泡スチロール': '発泡材', '使用済み食用油': '食用油',
  };
  return compact[canonical] ?? canonical;
}
