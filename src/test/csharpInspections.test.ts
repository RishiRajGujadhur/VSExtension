import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { inspectCSharp } from '../csharp/inspections';
import { parseCSharp } from '../csharp/parser';

const findings = async (code: string) => {
  const tree = await parseCSharp(code);
  try {
    return inspectCSharp(tree).map((f) => `${f.inspection}: ${code.slice(f.start, f.end)}`);
  } finally {
    tree.delete();
  }
};

test('C# inspections: each slip is found where it is', async () => {
  const code = `class A {
    int total;
    async void Save() { await Task.Delay(1); }
    async void OnClick(object sender, EventArgs e) { await Task.Delay(1); }
    async Task Load() { }
    void Run(int total) {
      total = total;
      this.total = total;
      if (total == total) { }
      if (Next() == Next()) { }
      if (ready); Go();
      if (ok) { Go(); } else { Go(); }
      if (true) Stop();
      while (false) { }
      try { Go(); } catch { }
      try { Go(); } catch (IOException) { /* fine: the file is optional */ }
      try { Go(); } catch (Exception ex) { Log(ex); throw ex; }
      try { Go(); } catch (Exception ex) { throw; }
    }
  }`;
  assert.deepEqual(await findings(code), [
    'csharpAsyncVoid: Save',
    'csharpSelfAssignment: total = total',
    'csharpSelfComparison: total == total',
    'csharpEmptyIf: ;',
    'csharpIdenticalBranches: ok',
    'csharpConstantCondition: true',
    'csharpConstantCondition: false',
    'csharpEmptyCatch: catch',
    'csharpThrowEx: throw ex;',
  ]);
});

test('C# inspections: clean code has no findings', async () => {
  assert.deepEqual(await findings('class B { int F(int x) { if (x > 0) return x; try { G(); } catch (Exception e) { Log(e); throw; } return -x; } }'), []);
});
