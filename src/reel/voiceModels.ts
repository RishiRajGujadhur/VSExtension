import * as fs from 'fs';
import * as path from 'path';
import type { ModelFile } from './codeModelText';
import { downloadPinned, isDownloaded } from './pinnedDownload';

/**
 * The voice models the Git reel's voice-over can use: the Kitten TTS 0.8 family by KittenML (Apache-2.0), all
 * with the same eight voices and the same engine. None is bundled with the extension: you choose one, and it is
 * downloaded once from Hugging Face (pinned to one version, every file checked against its hash), then runs on this
 * computer. Nano int8 is the recommended one: the smallest download, and the quickest to speak.
 */
export interface VoiceModel {
  id: string;
  /** As people see it: "Kitten Nano (recommended)". */
  name: string;
  /** As the player's voice picker groups its voices, without the brand: "Nano", "Mini". */
  short: string;
  /** One line on what to expect. */
  note: string;
  repo: string;
  revision: string;
  /** The model and its voices file, downloaded under these names. */
  files: ModelFile[];
  /** The download, in MB, for the prompts. */
  megabytes: number;
  /** The model has per-voice speed priors (Nano does): its voices are slowed to them. */
  speedPriors: boolean;
  recommended?: boolean;
}

const VOICES_NANO = { path: 'voices.npz', name: 'voices.npz', size: 3278902, sha256: '8aa7cee235abb0739cb51e6559685f65a4dacd95568833d05699b1633f519b3f' };

export const VOICE_MODELS: VoiceModel[] = [
  {
    id: 'kitten-nano-int8',
    name: 'Kitten Nano',
    short: 'Nano',
    note: 'The quickest to speak and the smallest download: recommended.',
    repo: 'KittenML/kitten-tts-nano-0.8-int8',
    revision: '84781d74e29ee25217551556398b42f80593a813',
    files: [{ path: 'kitten_tts_nano_v0_8.onnx', name: 'model.onnx', size: 24369971, sha256: 'f7b0afcbee92870b32b8e0276d855b954dc25470c9f051b376ac7eee537c76fc' }, VOICES_NANO],
    megabytes: 27.6,
    speedPriors: true,
    recommended: true,
  },
  {
    id: 'kitten-nano',
    name: 'Kitten Nano, full precision',
    short: 'Nano full precision',
    note: 'The same voices, a little cleaner, at twice the size.',
    repo: 'KittenML/kitten-tts-nano-0.8-fp32',
    revision: 'e73cfb095bd949c786ccdcf3b8ab04eb36c47442',
    files: [{ path: 'kitten_tts_nano_v0_8.onnx', name: 'model.onnx', size: 56767095, sha256: '320564d2615f235de972ca27a7f39551c94185cfa24ca85b07a29084135f1e5e' }, VOICES_NANO],
    megabytes: 60.0,
    speedPriors: true,
  },
  {
    id: 'kitten-micro',
    name: 'Kitten Micro',
    short: 'Micro',
    note: 'A larger model: more natural, slower to speak.',
    repo: 'KittenML/kitten-tts-micro-0.8',
    revision: '1ccf72b2c2048fd17efac7de2fab32d10e225084',
    files: [
      { path: 'kitten_tts_micro_v0_8.onnx', name: 'model.onnx', size: 41384970, sha256: '95481626fee1ba70ce683e69c534fc7cb38433c46ce42d3abbeafb4b9f1a4123' },
      { path: 'voices.npz', name: 'voices.npz', size: 3278902, sha256: '112710c1be8ad0e967c190fb0fd95cbe5848ec4791b93209f20b28b7da20dac1' },
    ],
    megabytes: 44.7,
    speedPriors: false,
  },
  {
    id: 'kitten-mini',
    name: 'Kitten Mini',
    short: 'Mini',
    note: 'The largest: the most natural voices, the slowest to speak.',
    repo: 'KittenML/kitten-tts-mini-0.8',
    revision: 'c02725660cea441db4c383af69f1f26f5cd00947',
    files: [
      { path: 'kitten_tts_mini_v0_8.onnx', name: 'model.onnx', size: 78268016, sha256: '0f5bbae4fc4800c98dbc544a87ecfa79510de2fb8222db30d12e5bfe9177df91' },
      { path: 'voices.npz', name: 'voices.npz', size: 3278902, sha256: '40ad2638952b77b7b2f30127e2608e169fc69dd256b53bd8aaa3409a33193c42' },
    ],
    megabytes: 81.5,
    speedPriors: false,
  },
];

/** The setting's value for your computer's own voice: nothing to download. */
export const SYSTEM_VOICE_MODEL = 'system';
export const DEFAULT_VOICE_MODEL = 'kitten-nano-int8';

export const voiceModel = (id: string | undefined): VoiceModel | undefined => VOICE_MODELS.find((m) => m.id === id);

/** Where downloaded voice models are kept: one folder each, in the extension's storage. */
export class VoiceModelStore {
  constructor(private readonly root: string) {}

  dir(model: VoiceModel): string {
    return path.join(this.root, model.id);
  }

  downloaded(model: VoiceModel): boolean {
    return isDownloaded(this.dir(model), model.files);
  }

  /** The voice models on this computer. */
  list(): VoiceModel[] {
    return VOICE_MODELS.filter((m) => this.downloaded(m));
  }

  download(model: VoiceModel, onProgress?: (received: number, total: number) => void, cancelled?: () => boolean): Promise<void> {
    return downloadPinned(this.dir(model), model.files, model, onProgress, cancelled);
  }

  remove(model: VoiceModel): void {
    fs.rmSync(this.dir(model), { recursive: true, force: true });
  }
}
