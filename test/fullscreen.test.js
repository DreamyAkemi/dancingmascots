'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fullscreenDisplayId } = require('../src/main/fullscreen');

const displays = [
  { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } },
];
const NO_TITLEBAR = 0x80000000, TITLEBAR = 0x00c00000;
const win = (over) => ({ style: NO_TITLEBAR, className: 'UnityWndClass', ownWindow: false, ...over });

test('borderless window covering display 2 is fullscreen on display 2', () => {
  assert.strictEqual(fullscreenDisplayId({ x: 1920, y: 0, width: 2560, height: 1440 }, displays, win()), 2);
});
test('maximized window with a title bar is not fullscreen', () => {
  assert.strictEqual(fullscreenDisplayId({ x: 0, y: 0, width: 1920, height: 1080 }, displays, win({ style: TITLEBAR })), null);
});
test('a smaller window is not fullscreen', () => {
  assert.strictEqual(fullscreenDisplayId({ x: 100, y: 100, width: 800, height: 600 }, displays, win()), null);
});
test('desktop and our own windows never count', () => {
  const full = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.strictEqual(fullscreenDisplayId(full, displays, win({ className: 'WorkerW' })), null);
  assert.strictEqual(fullscreenDisplayId(full, displays, win({ ownWindow: true })), null);
});
