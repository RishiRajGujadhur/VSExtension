/**
 * The Welcome page's steps, read from the walkthrough in package.json so both stay the same: each step's text
 * as runs of plain and bold words, its buttons (the `[label](command:id)` links), and the picture of its media page.
 */

export interface WelcomeText {
  text: string;
  bold?: boolean;
}

export interface WelcomeStep {
  id: string;
  title: string;
  text: WelcomeText[];
  buttons: { label: string; command: string }[];
  image?: { file: string; alt: string; caption?: string };
}

interface WalkthroughStep {
  id: string;
  title: string;
  description: string;
  media?: { markdown?: string; image?: string | Record<string, string>; altText?: string };
}

const link = /\[([^\]]+)\]\(command:([\w.-]+)\)/g;

/** `Press **Ctrl+F6** to…` as runs of plain and bold text. */
export function boldRuns(text: string): WelcomeText[] {
  const runs: WelcomeText[] = [];
  const parts = text.split(/\*\*/);
  parts.forEach((part, i) => {
    if (part) runs.push(i % 2 ? { text: part, bold: true } : { text: part });
  });
  return runs;
}

/** The first picture of a walkthrough media page (`<img src alt>`) and its caption (the first `<em>`). */
export function pictureOf(markdown: string): WelcomeStep['image'] {
  const img = /<img\s[^>]*src="([^"]+)"[^>]*>/i.exec(markdown) ?? /!\[([^\]]*)\]\(([^)\s]+)\)/.exec(markdown);
  if (!img) return undefined;
  const isHtml = img[0].startsWith('<');
  const file = isHtml ? img[1] : img[2];
  const alt = isHtml ? (/alt="([^"]*)"/i.exec(img[0])?.[1] ?? '') : img[1];
  const caption = /<em>([^<]+)<\/em>/i.exec(markdown)?.[1];
  return { file, alt, caption };
}

/** The steps of a walkthrough; `readMedia` returns the text of a step's markdown media file (undefined if missing). */
export function welcomeSteps(steps: readonly WalkthroughStep[], readMedia: (path: string) => string | undefined): WelcomeStep[] {
  return steps.map((step) => {
    const buttons = [...step.description.matchAll(link)].map((m) => ({ label: m[1], command: m[2] }));
    const prose = step.description.replace(link, '').replace(/\s*\n\s*/g, ' ').trim();
    let image: WelcomeStep['image'];
    const markdown = step.media?.markdown;
    if (markdown) {
      const picture = pictureOf(readMedia(markdown) ?? '');
      // A picture's path is relative to its media page.
      if (picture) image = { ...picture, file: `${markdown.slice(0, markdown.lastIndexOf('/') + 1)}${picture.file}` };
    } else if (typeof step.media?.image === 'string') {
      image = { file: step.media.image, alt: step.media.altText ?? '' };
    }
    return { id: step.id, title: step.title, text: boldRuns(prose), buttons, image };
  });
}
