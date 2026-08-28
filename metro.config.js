const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// The marketing dashboard (marketing/dashboard) is a standalone Next.js app with
// its own node_modules. Metro crawls from the repo root, so without this it would
// watch a second React tree — slow startup, wasted watcher FDs, and duplicate
// package warnings. Nothing in the app imports from there.
config.resolver.blockList = [
  new RegExp(`^${path.resolve(__dirname, 'marketing/dashboard').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(node_modules|\\.next|\\.data)/.*$`),
];

module.exports = config;
