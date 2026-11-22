import * as vscode from 'vscode';
import type { CodeModel } from '../reel/codeModel';
import { boxWords, FLOW_PURPOSES, meaningMatches, modelPurpose, Purpose, purposeIndex, rulePurpose, searchWords } from '../structure/flowPurpose';

/**
 * The code model in a chart, when you turn it on there (the wand button, or Charts: code model in the settings):
 * each box gets a tag for what it is for, and Find also finds boxes by meaning. One setting for every chart (graphs,
 * analysis charts, flowcharts); everything is worked out on this computer, and nothing changes while it is off.
 */
export const chartsSetting = 'tsStructure.charts.codeModel';
/** The setting before it covered every chart: on there still means on. */
const dataFlowSetting = 'tsStructure.dataFlow.codeModel';

export interface MeaningSource {
  codeModel: CodeModel;
  confirmAndDownloadCodeModel(): Promise<boolean>;
}

/** A box of a chart, as the code model reads it: `label` is its own code, `text` the label and where it is. */
export interface MeaningItem {
  key: string;
  label: string;
  text: string;
  /** Only gathers other boxes (a group, a function's name): no tag. */
  group?: boolean;
}

export function chartsCodeModelOn(): boolean {
  const config = vscode.workspace.getConfiguration();
  return config.get<boolean>(chartsSetting, false) || config.get<boolean>(dataFlowSetting, false);
}

export class ChartMeaning {
  private source: MeaningSource | undefined;
  private vectors: { key: string; vector: Float32Array; purpose?: number }[] = [];
  private meanings: Float32Array[] | undefined;
  private run = 0;
  /** For tests: what the chart was last told. */
  state: { available: boolean; on: boolean; purposes: Record<string, Purpose> } = { available: false, on: false, purposes: {} };

  use(source: MeaningSource): void {
    this.source = source;
  }

  /** On in the settings, and the model is on this computer. */
  on(): boolean {
    return !!this.source && chartsCodeModelOn() && this.source.codeModel.runnable;
  }

  /**
   * What each box is for: a rule on its code first, else the model (on the box's own code, and only when it has
   * enough words to go on); kept for Find. `post` is told twice: at once (on or off), then with the tags.
   */
  async analyse(items: MeaningItem[], post: (state: ChartMeaning['state']) => void): Promise<void> {
    const run = ++this.run;
    this.vectors = [];
    const on = this.on();
    this.state = { available: !!this.source, on: false, purposes: {} };
    post({ available: !!this.source, on, purposes: {} });
    if (!on || !items.length || !this.source) return;
    const model = this.source.codeModel;
    try {
      this.meanings ??= await model.embed(FLOW_PURPOSES.map((k) => k.meaning));
      const own = await model.embed(items.map((b) => boxWords(b.label)));
      if (run !== this.run) return;
      const purposes: Record<string, Purpose> = {};
      items.forEach((b, i) => {
        if (b.group) return;
        const purpose = rulePurpose(b.text) ?? modelPurpose(own[i], this.meanings!, boxWords(b.label));
        if (purpose) purposes[b.key] = purpose;
      });
      const searchable = await model.embed(items.map((b) => searchWords(b.text, purposes[b.key])));
      if (run !== this.run) return;
      this.vectors = items.map((b, i) => ({ key: b.key, vector: searchable[i], purpose: purposeIndex(purposes[b.key]) }));
      this.state = { available: true, on: true, purposes };
      post(this.state);
    } catch (error) {
      post({ available: true, on: false, purposes: {}, error: error instanceof Error ? error.message : String(error) } as ChartMeaning['state']);
    }
  }

  /** The keys of the boxes that mean what was typed (none while off). */
  async find(text: string): Promise<string[]> {
    if (!this.on() || !this.vectors.length || text.trim().length < 3) return [];
    const [query] = await this.source!.codeModel.embed([text]);
    return meaningMatches(query, this.vectors, this.meanings ?? []);
  }

  /** The wand button: on (downloading the model first, once you agree) or off, for every chart. */
  async toggle(): Promise<void> {
    if (!this.source) return;
    const config = vscode.workspace.getConfiguration();
    if (chartsCodeModelOn()) {
      await config.update(chartsSetting, false, vscode.ConfigurationTarget.Global);
      if (config.inspect(dataFlowSetting)?.globalValue !== undefined) await config.update(dataFlowSetting, undefined, vscode.ConfigurationTarget.Global);
      return;
    }
    if (!this.source.codeModel.runnable && !(await this.source.confirmAndDownloadCodeModel())) return;
    await config.update(chartsSetting, true, vscode.ConfigurationTarget.Global);
  }

  /** Runs `then` when the setting changes. */
  static onChange(then: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => (e.affectsConfiguration(chartsSetting) || e.affectsConfiguration(dataFlowSetting)) && then());
  }
}
