// Run by the privacy test under block-network.cjs: narrates a caption with a downloaded voice model and prints the result.
const path = require('path');
const { KittenNarrator } = require(path.resolve(__dirname, '../out/reel/kitten'));
const { testVoiceModel } = require('./voice-model.cjs');
const root = path.resolve(__dirname, '..');
(async () => {
  const narrator = new KittenNarrator(path.join(root, 'dist', 'kitten'), path.join(root, 'dist', 'kittenWorker.js'));
  narrator.use(testVoiceModel());
  try {
    const clips = await narrator.speak([{ id: 'a', text: 'apply Coupon now returns 0 early when the amount is at most 0.' }], 'Jasper', process.env.CACHE_DIR);
    process.stdout.write(JSON.stringify({ seconds: clips[0] ? clips[0].seconds : 0 }));
  } finally {
    narrator.dispose();
  }
})().catch((error) => {
  process.stdout.write(JSON.stringify({ error: String(error && error.message) }));
  process.exitCode = 1;
});
