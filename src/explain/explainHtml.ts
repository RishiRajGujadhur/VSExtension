import type { CodeExplanation } from './explainCode';
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The explanation as the page shows it. */
export function explanationHtml(e: CodeExplanation, withModel: boolean): string {
  const subject = e.subject.replace(/(\w+\(\))/, '<code>$1</code>');
  const purpose = e.purpose
    ? `<div class="purpose"><i class="codicon codicon-lightbulb" aria-hidden="true"></i><span>${escape(e.purpose.text)}</span><small>${e.purpose.by === 'model' ? 'named by the code model' : "by Code X-Ray's rules"}</small></div>`
    : '';
  const steps = e.steps.length ? `<ol>${e.steps.map((s) => `<li>${escape(s)}</li>`).join('')}</ol>` : '<p class="empty">Nothing here to put in words: highlight a whole function, or lines that call, set, check or return something.</p>';
  const privacy = withModel
    ? 'Explained on your computer by Code X-Ray\'s rules and the downloaded code model. Nothing was sent anywhere.'
    : 'Explained on your computer by Code X-Ray\'s rules. Nothing was sent anywhere.';
  // A whole function can be watched as a video: its steps on its flowchart, read aloud. A command link: the page runs
  // no scripts.
  const video = e.walk
    ? `<a class="video" href="command:tsStructure.explainCode.video" title="A video of these steps on the function's flowchart, with the voice-over, in the Git reel's player"><i class="codicon codicon-device-camera-video" aria-hidden="true"></i>Generate video</a>`
    : '';
  // "What the function poll() does", "What these lines in poll() do".
  const heading = /^the highlighted lines/.test(e.subject) ? `What ${subject.replace(/^the highlighted lines/, "these lines")} do` : `What ${subject} does`;
  return `<header><h1>${heading}</h1>${video}</header>
${e.summary ? `<p class="summary">${escape(e.summary)}</p>` : ''}
${purpose}
${steps}
<p class="privacy"><i class="codicon codicon-shield" aria-hidden="true"></i><span>${privacy}</span></p>`;
}
