const fs = require('node:fs');
const path = require('node:path');

const podspecPath = path.join(
  __dirname,
  '../node_modules/react-native/sdks/hermes-engine/hermes-engine.podspec'
);

if (!fs.existsSync(podspecPath)) {
  process.exit(0);
}

const source = fs.readFileSync(podspecPath, 'utf8');
const resolvers = [
  /(react_native_path = File\.dirname\(Pod::Executable\.execute_command\('node', \['-p',[\s\S]*?\]\))\.strip(?:\.force_encoding\(Encoding::UTF_8\))?/m,
  /(hermes_compiler_path = File\.dirname\(Pod::Executable\.execute_command\('node', \['-p',[\s\S]*?\]\))\.strip(?:\.force_encoding\(Encoding::UTF_8\))?/m,
];

let patched = source;
for (const resolver of resolvers) {
  if (!resolver.test(patched)) {
    throw new Error(`Could not find a Hermes podspec path resolver in ${podspecPath}`);
  }
  patched = patched.replace(resolver, '$1.strip.force_encoding(Encoding::UTF_8)');
}

if (patched !== source) {
  fs.writeFileSync(podspecPath, patched);
  console.log('Applied UTF-8 path compatibility for Hermes CocoaPods paths.');
}
