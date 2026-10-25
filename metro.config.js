// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// expo-sqlite loads its WebAssembly database engine in browser builds.
config.resolver.assetExts.push('wasm');

module.exports = config;
