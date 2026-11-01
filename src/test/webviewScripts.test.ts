import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';

const uiDir = path.resolve(__dirname, '../../src/ui');

// Webview pages are built as TypeScript template literals, where `\s` in the source becomes a plain `s` in the
// page. Regex escapes in their scripts need a double backslash.
test('webview scripts double the backslash of regex escapes', () => {
  for (const file of fs.readdirSync(uiDir).filter((f) => f.endsWith('.ts'))) {
    const source = fs.readFileSync(path.join(uiDir, file), 'utf8');
    for (const script of source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
      const single = /(^|[^\\])\\[sSdDwWbB]/.exec(script[1]);
      assert.equal(single, null, `${file}: single-backslash escape near ${single?.[0]} in a webview script`);
    }
  }
});
