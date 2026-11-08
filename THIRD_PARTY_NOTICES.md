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
