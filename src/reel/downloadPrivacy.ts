import type { ModelFile } from './codeModelText';

/** Hugging Face's own privacy policy: how it treats the requests it receives. */
export const HUGGING_FACE_PRIVACY = 'https://huggingface.co/privacy';

/** A model that can be downloaded, as the notice describes it. */
export interface DownloadedModel {
  /** "the code model (all-MiniLM-L6-v2)", "Kitten TTS Nano 0.8 int8". */
  name: string;
  repo: string;
  revision: string;
  files: readonly ModelFile[];
  megabytes: number;
}

/** What the model does once it is on this computer. */
export interface ModelUse {
  /** What it is given to read when it runs: "the words of each chart box and of what you type in Find". */
  reads: string;
  /** What it gives back: "a list of numbers for each text, compared on this computer". */
  gives: string;
  /** Where the files are kept. */
  folder: string;
  /** How to remove it: "run Git reel: remove the code model". */
  remove: string;
  /** What it keeps on disk after running, if anything: "the spoken clips, as WAV files in …, so …". */
  keeps?: string;
}

/**
 * Exactly what downloading a model does with your data, said at the download step itself, before anything is sent:
 * what goes to Hugging Face, what never does, what Hugging Face may do with the request, where the files are kept,
 * and what the model reads once it runs (on this computer only). Every line is true of src/reel/pinnedDownload.ts,
 * the only code in the extension that makes a network request.
 */
export function downloadPrivacy(model: DownloadedModel, use: ModelUse): string {
  const files = model.files.map((f) => f.name);
  const fileList = files.length > 1 ? `${files.slice(0, -1).join(', ')} and ${files[files.length - 1]}` : files[0];
  return [
    `WHAT IS SENT. ${files.length === 1 ? 'One request' : `${files.length} requests`} over HTTPS to huggingface.co, one for each file (${fileList}, ${model.megabytes} MB in all), from ${model.repo} at version ${model.revision.slice(0, 7)}. Hugging Face may redirect a request to its own file storage (*.hf.co), which receives the same request; no other site is ever contacted. Each request carries only the address of the file, the client name "code-x-ray" and "Accept: */*", and, as with any connection, your IP address.`,
    'WHAT IS NEVER SENT. Your code, file names or paths, project, repository or branch names, Git history, captions, recordings, settings, VS Code or Hugging Face account, tokens or cookies. There is no sign-in, and Code X-Ray collects no usage data or telemetry.',
    `HOW HUGGING FACE MAY USE IT. Like any website, Hugging Face may log each request (your IP address, the time and the file asked for) and handles that under its own privacy policy (${HUGGING_FACE_PRIVACY}). Code X-Ray has no account or agreement with Hugging Face and gets nothing back but the files.`,
    `ON YOUR COMPUTER. Each file is checked against its published hash; a file that does not match is thrown away. The files are kept in ${use.folder}.`,
    `WHEN IT RUNS. Offline, in a background thread on your computer. It reads ${use.reads}. It gives back ${use.gives}. ${use.keeps ? `It keeps ${use.keeps}, and sends nothing.` : 'What it reads stays in memory: the model saves nothing and sends nothing.'}`,
    `TO REMOVE IT. ${use.remove.charAt(0).toUpperCase()}${use.remove.slice(1)}.`,
  ].join('\n\n');
}
