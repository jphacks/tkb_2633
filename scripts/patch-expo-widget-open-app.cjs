const fs = require('node:fs');
const path = require('node:path');

const intentPath = path.join(
  __dirname,
  '../node_modules/expo-widgets/ios/Widgets/AppIntent.swift',
);

if (!fs.existsSync(intentPath)) {
  process.exit(0);
}

const source = fs.readFileSync(intentPath, 'utf8');
if (/struct WidgetUserInteraction: AppIntent \{[\s\S]*?static var openAppWhenRun: Bool = true/.test(source)) {
  process.exit(0);
}

const interactionIntent = /(struct WidgetUserInteraction: AppIntent \{[\s\S]*?static var isDiscoverable: Bool = false)/;
if (!interactionIntent.test(source)) {
  throw new Error(`Could not find WidgetUserInteraction AppIntent in ${intentPath}`);
}

fs.writeFileSync(
  intentPath,
  source.replace(interactionIntent, '$1\n  static var openAppWhenRun: Bool = true'),
);
console.log('Configured Expo widget interactions to run in the app process.');
