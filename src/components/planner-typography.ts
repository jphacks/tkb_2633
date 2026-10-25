// Shared phone text roles. Keep hierarchy in size as well as weight/color.
export const typography = {
  title: { fontSize: 28, lineHeight: 36 },
  section: { fontSize: 22, lineHeight: 30 },
  subheading: { fontSize: 19, lineHeight: 27 },
  body: { fontSize: 17, lineHeight: 26 },
  control: { fontSize: 18, lineHeight: 26 },
  label: { fontSize: 16, lineHeight: 24 },
  caption: { fontSize: 14, lineHeight: 21 },
  small: { fontSize: 12, lineHeight: 18 },
  // Dense calendar and tab labels are shared exceptions, not per-page font guesses.
  calendarDate: { fontSize: 18, lineHeight: 24 },
  calendarLabel: { fontSize: 14, lineHeight: 19 },
  tab: { fontSize: 14, lineHeight: 20 },
} as const;
