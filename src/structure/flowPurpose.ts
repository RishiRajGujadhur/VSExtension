import type { Diagram, DiagramNode } from './diagram';
import { codeAsWords, cosine } from '../reel/codeModelText';

/**
 * What each box of a Data flow chart is for, as a short tag with an icon: "Checks disk", "Network", "Module"…, and
 * finding boxes by meaning. Used only when you turn the code model on for Data flow: rules read the box's code first
 * (known APIs), and the code model (all-MiniLM-L6-v2, on this computer) places the boxes the rules cannot, by how
 * close their words are to a plain description of each purpose.
 */
export interface Purpose {
  label: string;
  icon: string;
  /** Who said so: a rule on the code, or the code model. */
  by: 'rules' | 'model';
}

interface PurposeKind {
  label: string;
  icon: string;
  /** Known code for it, the first rule that matches wins. */
  code?: RegExp;
  /** What it means, in words, for the code model. */
  meaning: string;
}

export const FLOW_PURPOSES: PurposeKind[] = [
  { label: 'Checks disk', icon: 'file', code: /\b(existsSync|exists|access|accessSync|stat|statSync|lstat)\(|\b(File|Directory)\.Exists\(/, meaning: 'check whether a file or folder exists on disk' },
  { label: 'File', icon: 'file', code: /\b(readFile|writeFile|appendFile|createReadStream|createWriteStream|unlink|mkdir|rmSync|copyFile)\w*\(|\b(File|Directory)\.\w+\(|\bnew (StreamWriter|StreamReader|FileStream)\b/, meaning: 'read, write or save a file on disk' },
  { label: 'Network', icon: 'cloud', code: /\b(fetch|axios|apiCall|request|http\w*\.|HttpClient\b|\.(get|post|put|patch|delete)\(\s*['"`/]|\.(GetAsync|PostAsync|PutAsync|DeleteAsync|SendAsync|GetStringAsync|GetFromJsonAsync|PostAsJsonAsync)\()/i, meaning: 'send a request over the network to a server or an api' },
  { label: 'JSON', icon: 'json', code: /\bJSON\.(stringify|parse)\(|\bJsonSerializer\.(Serialize|Deserialize)\w*\(|\bJsonConvert\.\w+\(/, meaning: 'turn it into JSON text, or read it back from JSON' },
  { label: 'Module', icon: 'package', code: /\b(require|createRequire|import)\s*\(|\bAssembly\.Load\w*\(/, meaning: 'load a module, a package or a library' },
  { label: 'Config', icon: 'settings-gear', code: /\b(process\.env|getConfiguration|config\.|settings\.|options\.|Environment\.GetEnvironmentVariable|IConfiguration|_?configuration\[|ConfigurationManager\.)/, meaning: 'read configuration, settings or environment variables' },
  { label: 'Stored', icon: 'database', code: /\b(localStorage|sessionStorage|indexedDB|\.save\(|db\.|repository\.|INSERT\b|UPDATE\b|SaveChanges(Async)?\(|_?context\.\w+\.(Add|Update|Remove)\()/i, meaning: 'save it in a database or in storage' },
  { label: 'Logged', icon: 'output', code: /\b(console\.\w+|logger\.\w+|log)\(|\b(Console\.Write\w*|Debug\.Write\w*|Trace\.\w+|_?logger\.Log\w*)\(/, meaning: 'log a message for debugging' },
  { label: 'Shown', icon: 'eye', code: /\b(innerHTML|textContent|render|setState|show\w*Message|notify|alert)\b/, meaning: 'show it on the screen or in the user interface' },
  { label: 'Error', icon: 'warning', code: /\b(throw|reject|new \w*Error|new \w*Exception)\b/, meaning: 'throw an error or reject when something fails' },
  { label: 'Sent', icon: 'broadcast', code: /\b(emit|dispatch|postMessage|send|publish)\(/, meaning: 'send a message or an event to another part of the program' },
  { label: 'Process', icon: 'terminal', code: /\b(spawn|exec|execFile|fork|child_process)\w*\(|\bProcess\.Start\(/, meaning: 'run another program or a shell command' },
  { label: 'Time', icon: 'watch', code: /\b(setTimeout|setInterval|Date\.now|performance\.now|Task\.Delay|Thread\.Sleep|DateTime\.(Now|UtcNow|Today)|Stopwatch\.)\b/, meaning: 'wait, schedule a timer or measure time' },
  { label: 'Input', icon: 'person', code: /\b(req\.(body|query|params)|argv|prompt\(|showInputBox|event\.target\.value|Console\.Read\w*|Request\.(Form|Query|Body))\b/, meaning: 'input from the user, a form, a request or the command line' },
];

/** How close a box must be to a purpose, and ahead of the next, for the model to tag it. */
export const PURPOSE_MIN = 0.25;
export const PURPOSE_MARGIN = 0.08;
/**
 * Find by meaning: a box matches what you typed through its purpose (what you typed is close to the purpose's
 * description, and to the box), or by being very close itself. A word that only looks alike ("chromodynamics" and
 * "chromium") does not make a match: Find's plain text search covers words.
 */
export const FIND_VIA_PURPOSE = 0.3;
export const FIND_WITH_PURPOSE = 0.2;
export const FIND_DIRECT = 0.5;

/** The boxes of a chart, keyed as the page keys them ("in/label/label", "out/label"), with the text to read. */
/** A box with no code of its own only gathers the boxes behind it (a function's name, a group): no tag for it. */
export const isGroup = (node: DiagramNode): boolean => !node.location && node.children.length > 0;

export function diagramBoxes(diagram: Diagram): { key: string; text: string; node: DiagramNode }[] {
  const out: { key: string; text: string; node: DiagramNode }[] = [];
  const walk = (nodes: DiagramNode[], parent: string) => {
    for (const node of nodes) {
      const key = `${parent}/${node.label}`;
      // The line number says nothing about what the code does.
      const description = (node.description ?? '').replace(/\bline \d+\b/g, '').replace(/^\s*·\s*|\s*·\s*$/g, '');
      out.push({ key, text: [node.label, description].filter(Boolean).join(' · '), node });
      walk(node.children, key);
    }
  };
  walk(diagram.left, 'in');
  walk(diagram.right, 'out');
  return out;
}

/** The purpose its code shows by a known API, if any. */
export function rulePurpose(text: string): Purpose | undefined {
  const kind = FLOW_PURPOSES.find((k) => k.code?.test(text));
  return kind ? { label: kind.label, icon: kind.icon, by: 'rules' } : undefined;
}

/** The words of a box, as the code model reads them. */
export const boxWords = (text: string): string => codeAsWords(undefined, [stripAnnotations(text)]) || text;

/**
 * The chart's own words on a box ("read:", "write:", "returned by", the arrow), which say how the value moves, not
 * what the code does: left out of what the model reads ("read: amount" is not reading a file).
 */
export const stripAnnotations = (text: string): string =>
  text
    .replace(/^\s*(→|←|=|read:|write:|written:|call:|returned by|passed to|argument of|reads?|writes?)\s*/i, '')
    .replace(/\s·\s(\d+ (reads?|writes?|calls?)|[\w.-]+\.(ts|tsx|js|jsx|cs|sql))\b/gi, '');

/** The purpose the code model sees: the closest description, when it is close enough and clearly ahead. */
export function modelPurpose(own: Float32Array, meanings: Float32Array[], words?: string): Purpose | undefined {
  // Fewer than three words ("launch browser") is too little to go on: no guess.
  if (words !== undefined && words.split(/\s+/).filter(Boolean).length < 3) return undefined;
  const ranked = meanings.map((m, i) => ({ i, score: cosine(m, own) })).sort((a, b) => b.score - a.score);
  const [best, next] = ranked;
  if (!best || best.score < PURPOSE_MIN || (next && best.score - next.score < PURPOSE_MARGIN)) return undefined;
  const kind = FLOW_PURPOSES[best.i];
  return { label: kind.label, icon: kind.icon, by: 'model' };
}

/** What a box is searched by: its words, and what its purpose means when it has one. */
export function searchWords(text: string, purpose: Purpose | undefined): string {
  const kind = purpose && FLOW_PURPOSES.find((k) => k.label === purpose.label);
  return `${boxWords(text)}${kind ? ` ${kind.meaning}` : ''}`;
}

/**
 * The boxes that mean what was typed, the closest first. `vector` is the box's searchWords; `purpose` the index in
 * FLOW_PURPOSES of its purpose, and `meanings` the purposes' vectors.
 */
export function meaningMatches(query: Float32Array, boxes: { key: string; vector: Float32Array; purpose?: number }[], meanings: Float32Array[], max = 12): string[] {
  return boxes
    .map((b) => {
      const direct = cosine(query, b.vector);
      const via = b.purpose !== undefined && b.purpose >= 0 ? cosine(query, meanings[b.purpose]) : 0;
      return { key: b.key, direct, ok: (via >= FIND_VIA_PURPOSE && direct >= FIND_WITH_PURPOSE) || direct >= FIND_DIRECT };
    })
    .filter((b) => b.ok)
    .sort((a, b) => b.direct - a.direct)
    .slice(0, max)
    .map((b) => b.key);
}

/** The index in FLOW_PURPOSES of a purpose. */
export const purposeIndex = (purpose: Purpose | undefined): number | undefined => (purpose ? FLOW_PURPOSES.findIndex((k) => k.label === purpose.label) : undefined);
