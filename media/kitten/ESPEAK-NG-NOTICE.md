# eSpeak NG in Code X-Ray's voice-over

Code X-Ray's Kitten voice-over turns text into phonemes with **eSpeak NG**, run as its own program, separate from
Code X-Ray:

- `phonemize.mjs`: the small program Code X-Ray starts. It reads text on its standard input and writes phonemes on
  its standard output. License: GPL-3.0-or-later.
- `phonemizer/phonemizer.js`: eSpeak NG and its English data, compiled to JavaScript by phonemizer.js
  (version 1.2.1, by Xenova). eSpeak NG is licensed GPL-3.0-or-later; the phonemizer.js wrapper is Apache-2.0 (its
  license is in `phonemizer/LICENSE`).

The full text of the GNU General Public License, version 3, is in `GPL-3.0.txt` in this folder.

## Source code

- eSpeak NG: https://github.com/espeak-ng/espeak-ng
- phonemizer.js, with the build that produced `phonemizer/phonemizer.js`: https://github.com/xenova/phonemizer.js
  (version 1.2.1, published on npm as `phonemizer@1.2.1`)
- `phonemize.mjs` is this file's neighbour, in source form.

Code X-Ray itself (MIT) does not include or link eSpeak NG: it starts `phonemize.mjs` as a separate process and
exchanges text with it. You may replace this folder's eSpeak NG program with your own build under the terms of the
GPL.
