/**
 * The work of others in Code X-Ray: libraries bundled with it and models it can download, each with who made it,
 * its license, where it comes from, what it does here and what it adds. Shown on the Credits page of Code X-Ray
 * Settings; THIRD_PARTY_NOTICES.md holds the license texts.
 */
export interface Credit {
  name: string;
  /** What it does in Code X-Ray. */
  usedFor: string;
  author: string;
  license: string;
  /** The project's page. */
  url: string;
  /** The license's text, when it has a page of its own. */
  licenseUrl?: string;
  /** Bundled in the extension, or downloaded only when you choose it. */
  shipped: 'bundled' | 'downloaded';
  /** What it adds: installed size, or the download. */
  size: string;
}

const APACHE = 'https://www.apache.org/licenses/LICENSE-2.0';
const MIT = 'https://opensource.org/license/mit';

export const credits: Credit[] = [
  {
    name: 'TypeScript',
    usedFor: 'Reads TypeScript and JavaScript for every analysis: flowcharts, data flow, usages, refactorings.',
    author: 'Microsoft',
    license: 'Apache-2.0',
    url: 'https://github.com/microsoft/TypeScript',
    licenseUrl: APACHE,
    shipped: 'bundled',
    size: '23.2 MB installed',
  },
  {
    name: 'web-tree-sitter',
    usedFor: 'Parses C# for its flowcharts and inspections.',
    author: 'Max Brunsfeld and the tree-sitter contributors',
    license: 'MIT',
    url: 'https://github.com/tree-sitter/tree-sitter',
    licenseUrl: MIT,
    shipped: 'bundled',
    size: '5.8 MB installed, with the C# grammar',
  },
  {
    name: 'tree-sitter-c-sharp',
    usedFor: 'The C# grammar web-tree-sitter reads with.',
    author: 'The tree-sitter contributors',
    license: 'MIT',
    url: 'https://github.com/tree-sitter/tree-sitter-c-sharp',
    licenseUrl: MIT,
    shipped: 'bundled',
    size: 'included above',
  },
  {
    name: 'VS Code Codicons',
    usedFor: 'The icons in the views, the charts and the videos.',
    author: 'Microsoft',
    license: 'CC BY 4.0 (icons), MIT (code)',
    url: 'https://github.com/microsoft/vscode-codicons',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    shipped: 'bundled',
    size: 'under 1 MB',
  },
  {
    name: 'robot-components',
    usedFor: 'The charts\' animated grid and flowing lines, adapted.',
    author: 'Robot FZCO',
    license: 'MIT',
    url: 'https://github.com/dashrobotco/robot-components',
    licenseUrl: MIT,
    shipped: 'bundled',
    size: 'a few KB (adapted code)',
  },
  {
    name: 'ONNX Runtime Web',
    usedFor: 'Runs the voice model and the code model on your computer (WebAssembly).',
    author: 'Microsoft',
    license: 'MIT',
    url: 'https://github.com/microsoft/onnxruntime',
    licenseUrl: MIT,
    shipped: 'bundled',
    size: '11.9 MB installed',
  },
  {
    name: 'phonemizer.js and eSpeak NG',
    usedFor: 'Turns the voice-over\'s words into sounds for the voice model. Runs as a separate program.',
    author: 'Joshua Lochner (phonemizer.js); the eSpeak NG contributors',
    license: 'Apache-2.0 (phonemizer.js), GPL-3.0-or-later (eSpeak NG)',
    url: 'https://github.com/espeak-ng/espeak-ng',
    licenseUrl: 'https://www.gnu.org/licenses/gpl-3.0.html',
    shipped: 'bundled',
    size: '1.3 MB installed',
  },
  {
    name: 'Kitten TTS (Nano, Micro, Mini 0.8)',
    usedFor: 'The natural voices of the Git reel\'s voice-over: Jasper, Bella, Luna, Bruno, Rosie, Hugo, Kiki and Leo.',
    author: 'KittenML / Stellon Labs',
    license: 'Apache-2.0',
    url: 'https://github.com/KittenML/KittenTTS',
    licenseUrl: APACHE,
    shipped: 'downloaded',
    size: 'the one you choose: 27.6 MB (Nano, recommended) to 81.5 MB (Mini)',
  },
  {
    name: 'all-MiniLM-L6-v2',
    usedFor: 'The code model: helps pick each file\'s key change and name what code is for.',
    author: 'The sentence-transformers team; the ONNX export by Xenova',
    license: 'Apache-2.0',
    url: 'https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2',
    licenseUrl: APACHE,
    shipped: 'downloaded',
    size: '23.2 MB, if you agree to it',
  },
];
