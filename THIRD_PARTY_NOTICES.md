# Third-party notices

Code X-Ray includes code adapted from the following projects.

## robot-components

https://github.com/dashrobotco/robot-components

The animated parts of the Data Flow and Control Flow graphs are adapted from the node grid demo of robot-components
(`app/nodegrid/page.tsx`):

- the dot grid behind the charts that bends around boxes, glows near the pointer and sends a wave on a click
  (`media/diagramGrid.js`);
- the flowing lines, a wire with soft pulses travelling along it (`attachFlowLines` in `media/chartKit.js`);
- the box style: rounded cards with a faint border and a soft shadow (`media/chart.css`).

```
MIT License

Copyright (c) 2026 Robot FZCO

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## VS Code Codicons

https://github.com/microsoft/vscode-codicons

The icon font used in the charts and views ships with its own license in `node_modules/@vscode/codicons`.

## web-tree-sitter

https://github.com/tree-sitter/tree-sitter

The C# parser runs on web-tree-sitter (bundled in `dist/extension.js`, with `dist/parsers/tree-sitter.wasm`).

```
The MIT License (MIT)

Copyright (c) 2018-2024 Max Brunsfeld

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## tree-sitter-c-sharp

https://github.com/tree-sitter/tree-sitter-c-sharp

The C# grammar, shipped as `dist/parsers/tree-sitter-c_sharp.wasm`.

```
The MIT License (MIT)

Copyright (c) 2014-2023 Max Brunsfeld, Damien Guard, Amaan Qureshi, and contributors.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Kitten TTS (the Git reel voice-over)

https://github.com/KittenML/KittenTTS and https://huggingface.co/KittenML/kitten-tts-nano-0.8-int8
(revision 84781d74e29ee25217551556398b42f80593a813)

The model `kitten_tts_nano_v0_8.onnx`, its voices `voices.npz` and `config.json` are bundled unchanged in
`dist/kitten/model`. They are licensed under the Apache License 2.0 by KittenML / Stellon Labs
(https://www.apache.org/licenses/LICENSE-2.0). The model architecture follows StyleTTS 2. Code X-Ray's own engine
(`src/reel/kittenModel.ts`, `src/reel/kittenWorker.ts`) follows the official KittenTTS-web engine
(https://github.com/KittenML/KittenTTS-web, Apache-2.0): its symbol table, style selection and speed priors.

## ONNX Runtime Web

https://github.com/microsoft/onnxruntime, onnxruntime-web 1.24.3. MIT License, Copyright (c) Microsoft Corporation.
Its WebAssembly build is bundled in `dist/kitten/ort`, with the license text in `dist/kitten/ort/LICENSE`.

## phonemizer.js and eSpeak NG

https://github.com/xenova/phonemizer.js (phonemizer 1.2.1, Apache-2.0) and https://github.com/espeak-ng/espeak-ng
(GPL-3.0-or-later). Bundled in `dist/kitten/phonemizer` and run as a separate program (`dist/kitten/phonemize.mjs`,
GPL-3.0-or-later) that Code X-Ray starts and talks to through its standard input and output only. Its license text and
source notice are in `dist/kitten/GPL-3.0.txt` and `dist/kitten/ESPEAK-NG-NOTICE.md`.
