import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectService } from '../analysis/project';

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-structure-cache-'));
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src'] }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  return dir;
}

test('a file changed on disk is read again; an unchanged project is reused', () => {
  const dir = tempProject();
  const file = path.join(dir, 'src', 'a.ts');
  const projects = new ProjectService();
  const first = projects.load(file);
  assert.equal(projects.load(file), first);
  fs.writeFileSync(file, 'export const a = 2; // changed on disk\n');
  const second = projects.load(file);
  assert.notEqual(second, first);
  assert.match(second.program.getSourceFile(second.program.getRootFileNames()[0])!.text, /changed on disk/);
});

test('a file created after the project was listed is found without a manual refresh', () => {
  const dir = tempProject();
  const projects = new ProjectService();
  projects.load(path.join(dir, 'src', 'a.ts'));
  const created = path.join(dir, 'src', 'b.ts');
  fs.writeFileSync(created, 'export const b = 1;\n');
  const project = projects.load(created);
  assert.ok(project.program.getSourceFiles().some((sf) => sf.fileName.endsWith('/src/b.ts')));
});

test('an analysis project is reused between runs and follows edits', () => {
  const dir = tempProject();
  const file = path.join(dir, 'src', 'a.ts');
  let overlay: string | undefined;
  const projects = new ProjectService((f) => (path.resolve(f) === path.resolve(file) ? overlay : undefined));
  const first = projects.analysisProject(file);
  const program = first.program();
  const again = projects.analysisProject(file);
  assert.equal(again, first);
  assert.equal(again.program(), program, 'nothing changed, so the program and its types are kept');
  overlay = 'export const a = "edited";\n';
  const edited = projects.analysisProject(file).program();
  assert.notEqual(edited, program);
  assert.match(edited.getSourceFile(edited.getRootFileNames()[0])!.text, /edited/);
  fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
  projects.invalidateFileList();
  const grown = projects.analysisProject(file).program();
  assert.ok(grown.getSourceFiles().some((sf) => sf.fileName.endsWith('/src/b.ts')), 'a new file is picked up once the file list is refreshed');
});

test('an analysis project reuses a recent disk check, and reads a file again once told it changed', () => {
  const dir = tempProject();
  const file = path.join(dir, 'src', 'a.ts');
  const projects = new ProjectService();
  const text = () => projects.analysisProject(file).sourceFile(file).text;
  assert.doesNotMatch(text(), /changed/);
  fs.writeFileSync(file, 'export const a = 3; // changed outside the editor\n');
  projects.fileChanged(file);
  assert.match(text(), /changed outside the editor/);
});
