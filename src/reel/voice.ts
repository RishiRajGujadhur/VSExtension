import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

/**
 * The reel's voice-over, read by the computer's own voice: System.Speech on Windows, `say` on macOS, espeak on Linux.
 * Offline and free; nothing is downloaded or sent. Each caption is recorded once to a WAV file, kept in a cache by
 * voice and text, so editing one caption records only that one again.
 */
const run = promisify(execFile);

export interface VoiceClip {
  id: string;
  /** Length of the clip, for timing its scene. */
  seconds: number;
  wav: Buffer;
}

/** The voices this computer has, by name; the first is the default. Empty when it has no voice the reel can use. */
export async function listVoices(): Promise<string[]> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name }'], { timeout: 30_000 });
      return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    }
    if (process.platform === 'darwin') {
      const { stdout } = await run('say', ['-v', '?'], { timeout: 15_000 });
      // "Samantha   en_US  # Hello…": English voices first.
      const voices = stdout.split('\n').map((l) => /^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})/.exec(l)).filter((m): m is RegExpExecArray => !!m);
      return [...voices.filter((m) => m[2].startsWith('en')), ...voices.filter((m) => !m[2].startsWith('en'))].map((m) => m[1].trim());
    }
    for (const tool of ['espeak-ng', 'espeak']) {
      try {
        await run(tool, ['--version'], { timeout: 5_000 });
        return [tool];
      } catch {
        // Not installed.
      }
    }
  } catch {
    // No voice.
  }
  return [];
}

/** How long a WAV file plays, from its header. */
export function wavSeconds(wav: Buffer): number {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') return 0;
  let at = 12;
  let byteRate = 0;
  while (at + 8 <= wav.length) {
    const id = wav.toString('ascii', at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === 'fmt ') byteRate = wav.readUInt32LE(at + 16);
    if (id === 'data') return byteRate ? Math.min(size, wav.length - at - 8) / byteRate : 0;
    at += 8 + size + (size % 2);
  }
  return 0;
}

/** Records each text with the voice (cached in `cacheDir`) and returns the clips, in order. */
export async function speak(items: { id: string; text: string }[], voice: string | undefined, cacheDir: string): Promise<VoiceClip[]> {
  fs.mkdirSync(cacheDir, { recursive: true });
  const target = (text: string) => path.join(cacheDir, `${createHash('sha1').update(`${process.platform}\n${voice ?? ''}\n${text}`).digest('hex').slice(0, 20)}.wav`);
  const missing = items.filter((i) => i.text.trim() && !fs.existsSync(target(i.text)));
  if (missing.length) {
    if (process.platform === 'win32') {
      // One PowerShell for all of them; the texts go through a JSON file, never through the command line.
      const list = path.join(cacheDir, `batch-${process.pid}.json`);
      const script = path.join(cacheDir, 'speak.ps1');
      fs.writeFileSync(list, JSON.stringify(missing.map((i) => ({ text: i.text, file: target(i.text) }))), 'utf8');
      fs.writeFileSync(
        script,
        [
          'param([string]$List, [string]$Voice)',
          'Add-Type -AssemblyName System.Speech',
          '$items = Get-Content -Raw -Encoding UTF8 -LiteralPath $List | ConvertFrom-Json',
          '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
          'if ($Voice) { try { $s.SelectVoice($Voice) } catch { } }',
          '$s.Rate = 0',
          'foreach ($i in $items) { $s.SetOutputToWaveFile($i.file); $s.Speak($i.text) }',
          '$s.SetOutputToNull()',
          '$s.Dispose()',
        ].join('\r\n'),
        'utf8',
      );
      try {
        await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-List', list, '-Voice', voice ?? ''], { timeout: 180_000 });
      } finally {
        fs.rmSync(list, { force: true });
      }
    } else if (process.platform === 'darwin') {
      for (const i of missing) await run('say', [...(voice ? ['-v', voice] : []), '-o', target(i.text), '--file-format=WAVE', '--data-format=LEI16@22050', i.text], { timeout: 60_000 });
    } else {
      const tool = voice === 'espeak' ? 'espeak' : 'espeak-ng';
      for (const i of missing) await run(tool, ['-w', target(i.text), i.text], { timeout: 60_000 });
    }
  }
  return items
    .filter((i) => i.text.trim() && fs.existsSync(target(i.text)))
    .map((i) => {
      const wav = fs.readFileSync(target(i.text));
      return { id: i.id, seconds: wavSeconds(wav), wav };
    });
}
