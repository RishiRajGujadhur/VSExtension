import type { CodeExplanation } from './explainCode';
import { FunctionFacts, FunctionOutput, typePhrase } from './functionFacts';
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Where the rules are explained, and the project's page: the info card links to them. */
export const RULES_URL = 'https://github.com/RishiRajGujadhur/VSExtension/blob/main/docs/HOW_EXPLAINING_WORKS.md';
export const README_URL = 'https://github.com/RishiRajGujadhur/VSExtension#privacy-and-size';

/** What did the explaining, exactly: shown in the info card at the bottom of the page. */
export interface ExplainedBy {
  /** Code X-Ray's version: "0.101.0". */
  version: string;
  /** What read the code: "the TypeScript 6.0.3 compiler". */
  reader: string;
  /** The code model, when it was ready to help. */
  model?: { name: string; revision: string; runtime: string };
}

/** Steps shown before "Show N more steps". */
const FIRST_STEPS = 5;

/** The explanation as the page shows it. The page runs no scripts: what opens and closes is HTML and CSS. */
export function explanationHtml(e: CodeExplanation, by: ExplainedBy): string {
  const subject = e.subject.replace(/(\w+\(\))/, '<code>$1</code>');
  const purpose = e.purpose
    ? `<div class="purpose"><i class="codicon codicon-lightbulb" aria-hidden="true"></i><span>${escape(e.purpose.text)}</span><small>${e.purpose.by === 'model' ? 'named by the code model' : "by Code X-Ray's rules"}</small></div>`
    : '';
  // A whole function can be watched as a video: its steps on its flowchart, read aloud. An icon button, a command link.
  const video = e.walk
    ? `<a class="video" href="command:tsStructure.explainCode.video" title="Generate video" aria-label="Generate video: these steps on the function's flowchart, read aloud, in the Git reel's player"><i class="codicon codicon-device-camera-video" aria-hidden="true"></i></a>`
    : '';
  // "What the function poll() does", "What these lines in poll() do".
  const heading = /^the highlighted lines/.test(e.subject) ? `What ${subject.replace(/^the highlighted lines/, 'these lines')} do` : `What ${subject} does`;
  return `<header><h1>${heading}</h1>${video}</header>
${e.summary ? `<p class="summary">${escape(e.summary)}</p>` : ''}
${purpose}
${e.facts ? factsHtml(e.facts) : ''}
${stepsHtml(e.steps)}
${footerHtml(e, by)}`;
}

/** The steps: the first few, the rest folded under "Show N more steps". */
function stepsHtml(steps: string[]): string {
  if (!steps.length) return '<p class="empty">Nothing here to put in words: highlight a whole function, or lines that call, set, check or return something.</p>';
  const item = (s: string) => `<li>${escape(s)}</li>`;
  const first = `<ol class="steps">${steps.slice(0, FIRST_STEPS).map(item).join('')}</ol>`;
  const rest = steps.slice(FIRST_STEPS);
  if (!rest.length) return `<h2 class="section">Step by step</h2>${first}`;
  return `<h2 class="section">Step by step</h2>${first}
<details class="more"><summary>Show ${rest.length} more step${rest.length === 1 ? '' : 's'}</summary><ol class="steps" start="${FIRST_STEPS + 1}">${rest.map(item).join('')}</ol></details>`;
}

/**
 * What it takes, gives back and changes, folded into one line ("Takes primary · gives back win · changes 3 things")
 * that opens to the three cards.
 */
function factsHtml(f: FunctionFacts): string {
  const takes = f.inputs.length
    ? `<ul>${f.inputs.map((i) => {
        const note = i.rest ? 'any number of them' : i.defaultValue ? `${i.defaultValue} when left out` : i.optional ? 'can be left out' : '';
        return `<li><code>${escape(i.rest ? `...${i.name.replace(/^\.\.\./, '')}` : i.name)}</code>${i.type ? `<span class="type">${escape(i.type)}</span>` : ''}${note ? `<span class="note">${escape(note)}</span>` : ''}</li>`;
      }).join('')}</ul>`
    : '<p>Nothing: it takes no parameters.</p>';
  const changes = f.effects.length ? `<ul>${f.effects.map((x) => `<li>${escape(x.charAt(0).toUpperCase() + x.slice(1))}</li>`).join('')}</ul>` : '<p>Nothing that Code X-Ray can see: it only works out its result.</p>';
  const names = f.inputs.map((i) => `<code>${escape(i.name.replace(/^\.\.\./, ''))}</code>`);
  const line = [
    f.inputs.length ? `Takes ${names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')}` : 'Takes nothing',
    outputShort(f.output),
    f.effects.length ? `changes ${f.effects.length === 1 ? '1 thing' : `${f.effects.length} things`} outside itself` : 'changes nothing outside itself',
  ].join(' · ');
  return `<details class="facts-box"><summary><span class="facts-line">${line}</span></summary>
<section class="facts">
<div><h2><i class="codicon codicon-arrow-right" aria-hidden="true"></i>Takes</h2>${takes}</div>
<div><h2><i class="codicon codicon-arrow-left" aria-hidden="true"></i>Gives back</h2><p>${outputHtml(f.output)}</p></div>
<div><h2><i class="codicon codicon-edit" aria-hidden="true"></i>Changes outside itself</h2>${changes}</div>
</section></details>`;
}

/** "gives back a Receipt", "gives back <code>win</code>", "gives back nothing": for the folded line. */
function outputShort(o: FunctionOutput): string {
  if (o.nothing) return 'gives back nothing';
  if (o.type) return `gives back ${escape(typePhrase(o.type))}`;
  return o.values.length === 1 ? `gives back <code>${escape(o.values[0])}</code>` : 'gives back a value';
}

/** The full sentence, its code as code: "Gives back a Receipt, once it finishes: <code>receipt</code>." */
function outputHtml(o: FunctionOutput): string {
  const code = (s: string) => `<code>${escape(s)}</code>`;
  if (o.nothing) return o.later ? 'Gives back nothing; it can be awaited until it finishes.' : 'Gives back nothing.';
  const what = o.type ? escape(typePhrase(o.type)) : o.values.length === 1 ? code(o.values[0]) : 'a value';
  const values = o.values.length > 1 || (o.type && o.values.length === 1) ? `: ${o.values.map(code).join(' or ')}` : '';
  return `Gives back ${what}${o.later ? ', once it finishes' : ''}${values}.`;
}

/**
 * The privacy line, short, with an info button: on hover or focus it shows exactly what explained the code (Code
 * X-Ray's version and rules, what read the code, and the code model, its version and runtime, when it was ready),
 * what it was used for here, and links to how the rules work and the privacy notes.
 */
function footerHtml(e: CodeExplanation, by: ExplainedBy): string {
  const modelUse = !by.model
    ? '<li><b>Code model:</b> not used (not downloaded, or turned off).</li>'
    : `<li><b>Code model:</b> ${escape(by.model.name)}, version ${escape(by.model.revision.slice(0, 7))}, run by ${escape(by.model.runtime)} in a background thread. ${e.purpose?.by === 'model' ? 'Here it named what the code is for.' : 'It was ready, but the rules were enough here.'} It only chooses a label; it never writes the text.</li>`;
  const tip = `<span class="tip" id="explainedBy" role="tooltip">
<span class="tip-title">How this was explained</span>
<ul>
<li><b>Code X-Ray ${escape(by.version)} rules</b> wrote every sentence, from what ${escape(by.reader)} works out: the flowchart, the parameters, the return value and what it changes.</li>
${modelUse}
<li><b>Nothing was sent anywhere:</b> no network request was made, and your code stayed on this computer.</li>
</ul>
<span class="tip-links"><a href="${RULES_URL}">How the rules work</a><a href="${README_URL}">Privacy and models</a></span>
</span>`;
  return `<footer class="privacy"><i class="codicon codicon-shield" aria-hidden="true"></i><span>Explained on your computer${by.model ? ' with the code model' : ''}. Nothing was sent anywhere.</span>
<span class="info" tabindex="0" role="button" aria-label="How this was explained" aria-describedby="explainedBy"><i class="codicon codicon-info" aria-hidden="true"></i>${tip}</span></footer>`;
}
