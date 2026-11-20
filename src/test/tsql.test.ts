import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { tokenize } from '../tsql/lexer';
import { routines } from '../tsql/parser';
import { tsqlFlowChart } from '../tsql/flow';
import { inspectTsql } from '../tsql/inspections';
import { tsqlCallGraph, tsqlUsages } from '../tsql/navigate';

const procedure = `CREATE OR ALTER PROCEDURE dbo.SaveOrder
  @OrderId INT,
  @Total DECIMAL(10,2) OUTPUT
AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @Count INT = 0
  SELECT @Count = COUNT(*) FROM dbo.Orders WHERE Id = @OrderId
  IF @Count = 0
  BEGIN
    RAISERROR('missing', 16, 1)
    RETURN -1
  END
  ELSE IF @Total < 0
    THROW 50001, 'negative', 1;
  WHILE @Count < 10
  BEGIN
    SET @Count += 1
    IF @Count = 5 CONTINUE
    IF @Count = 8 BREAK
    INSERT INTO dbo.Log (Msg) SELECT 'x' FROM dbo.Orders o WHERE o.Id = @OrderId UNION ALL SELECT 'y'
  END
  BEGIN TRY
    UPDATE dbo.Orders SET Total = @Total WHERE Id = @OrderId
  END TRY
  BEGIN CATCH
    ROLLBACK
    THROW
  END CATCH
  RETURN 0
END
GO
SELECT Id FROM dbo.Orders
GO`;

test('T-SQL tokens: strings, bracketed names, variables and nested comments', () => {
  const tokens = tokenize(`SELECT N'it''s', [Order Id], @x, @@ROWCOUNT /* a /* nested */ comment */ -- end\nFROM "t"`);
  assert.deepEqual(tokens.map((t) => `${t.kind}:${t.value}`), ['word:SELECT', "string:N'it''s'", 'punct:,', 'name:Order Id', 'punct:,', 'variable:@X', 'punct:,', 'variable:@@ROWCOUNT', 'comment:/* a /* nested */ comment */', 'comment:-- end', 'word:FROM', 'name:t']);
});

test('T-SQL routines: procedures with parameters, batches split at GO', () => {
  assert.deepEqual(routines(procedure).map((r) => [r.kind, r.name, r.key, r.parameters]), [
    ['procedure', 'dbo.SaveOrder', 'SAVEORDER', ['@OrderId', '@Total']],
    ['script', 'script (batch 2)', '', []],
  ]);
  const functions = routines('CREATE FUNCTION [dbo].[Fee] (@amount money) RETURNS money AS BEGIN RETURN @amount * 0.1 END');
  assert.deepEqual(functions.map((r) => [r.kind, r.name, r.parameters, r.body[0]?.kind]), [['function', 'dbo.Fee', ['@amount'], 'block']]);
});

test('T-SQL flowchart: IF/ELSE IF, WHILE with BREAK and CONTINUE, TRY/CATCH, RETURN and THROW', () => {
  const chart = tsqlFlowChart(procedure, 'c:/db/save.sql', procedure.indexOf('SET NOCOUNT'));
  assert.equal(chart.name, 'dbo.SaveOrder');
  assert.deepEqual(chart.nodes.map((n) => n.kind), ['start', 'end', 'statement', 'decision', 'statement', 'return', 'decision', 'throw', 'loop', 'statement', 'decision', 'decision', 'statement', 'statement', 'catch', 'statement', 'throw', 'return']);
  const edges = chart.edges.map((e) => `${chart.nodes[e.from].lines[0]} → ${chart.nodes[e.to].lines[0]}${e.label ? ` [${e.label}]` : ''}`);
  assert.ok(edges.includes('@Count = 5 → WHILE @Count < 10 [yes]'), 'CONTINUE goes back to the loop');
  assert.ok(edges.includes('@Count = 8 → UPDATE dbo.Orders SET Total = @Total WHERE Id = @OrderId [yes]'), 'BREAK leaves the loop');
  assert.ok(edges.includes('UPDATE dbo.Orders SET Total = @Total WHERE Id = @OrderId → BEGIN CATCH [error]'));
  assert.ok(edges.includes("THROW 50001, 'negative', 1 → end [throws]"));
  assert.ok(chart.nodes.some((n) => n.lines[0].startsWith("INSERT INTO dbo.Log (Msg) SELECT 'x'")), 'INSERT … SELECT … UNION ALL SELECT is one statement');
  const data = chart.dependences.data.map((d) => `${chart.nodes[d.from].lines[0]} → ${chart.nodes[d.to].lines[0]} (${d.name})`);
  assert.ok(data.includes('SET NOCOUNT ON → @Count = 0 (@Count)'), data.join('\n'));
  assert.ok(data.includes('dbo.SaveOrder → @Total < 0 (@Total)'), data.join('\n'));
  assert.equal(chart.paths.length, 10);
});

test('T-SQL flowchart: an impossible path, and GOTO', () => {
  const code = `CREATE PROC p @on BIT AS
IF @on = 1 PRINT 'a'
IF @on = 1 PRINT 'b' ELSE PRINT 'c'
retry:
IF @on = 0 GOTO retry`;
  const chart = tsqlFlowChart(code, 'c:/db/p.sql', 10);
  assert.ok(chart.paths.some((p) => !p.feasible), 'yes then no on the same unchanged @on is impossible');
  assert.ok(chart.edges.some((e) => e.label === 'goto' && chart.nodes[e.to].lines[0] === 'retry:'));
});

test('T-SQL inspections: each pattern is found where it is', () => {
  const code = `CREATE PROCEDURE dbo.Clean AS
BEGIN
  SELECT * FROM dbo.Orders WITH (NOLOCK)
  SELECT o.* FROM dbo.Orders o WHERE o.Note = NULL
  IF EXISTS (SELECT * FROM dbo.Orders) PRINT 'x'
  SELECT TOP 5 Id FROM dbo.Orders
  SELECT TOP 5 Id FROM dbo.Orders ORDER BY Id
  UPDATE dbo.Orders SET Note = NULL
  DELETE FROM @staging
  DELETE FROM dbo.Orders WHERE Id <> NULL
  DECLARE @n NTEXT
  SELECT @@IDENTITY
  BEGIN TRY SELECT 1 END TRY BEGIN CATCH END CATCH
END`;
  const found = inspectTsql(code).map((f) => `${f.inspection}: ${code.slice(f.start, f.end)}`);
  assert.deepEqual(found, [
    'tsqlNoCount: dbo.Clean',
    'tsqlSelectStar: SELECT *',
    'tsqlNoLock: NOLOCK',
    'tsqlSelectStar: SELECT o.*',
    'tsqlNullComparison: = NULL',
    'tsqlTopWithoutOrderBy: TOP',
    'tsqlUpdateWithoutWhere: UPDATE dbo',
    'tsqlNullComparison: <> NULL',
    'tsqlDeprecatedType: NTEXT',
    'tsqlIdentity: @@IDENTITY',
    'tsqlEmptyCatch: CATCH',
  ]);
});

const orders = { file: 'c:/db/orders.sql', text: `CREATE PROCEDURE dbo.SaveOrder @OrderId INT, @Total MONEY OUTPUT AS
BEGIN
  DECLARE @n INT
  SELECT @n = COUNT(*) FROM dbo.Orders WHERE Id = @OrderId
  UPDATE dbo.[Orders] SET Total = @Total WHERE Id = @OrderId
  INSERT INTO Orders (Id) VALUES (@OrderId)
  EXEC dbo.LogChange @OrderId
  SET @Total = dbo.Fee(@Total)
END
GO
CREATE FUNCTION dbo.Fee (@amount MONEY) RETURNS MONEY AS BEGIN RETURN @amount * 0.1 END` };
const log = { file: 'c:/db/log.sql', text: `CREATE PROC dbo.LogChange @Id INT AS DELETE FROM dbo.Orders WHERE Id = @Id
GO
CREATE PROC dbo.Nightly AS EXEC dbo.SaveOrder 1, NULL; EXEC sp_who` };
const rows = (r: ReturnType<typeof tsqlUsages>) => r.roots.map((g) => `${g.label}: ${(g.children ?? []).flatMap((f) => (f.children ?? []).map((c) => `${f.label}:${c.location!.line + 1}`)).join(', ')}`);

test('T-SQL Find usages: a table across files, by what each statement does with it', () => {
  const report = tsqlUsages([orders, log], orders.file, orders.text.indexOf('Orders WHERE') + 2);
  assert.equal(report.title, 'Usages of Orders');
  assert.deepEqual(rows(report), ['Writes: orders.sql:5, orders.sql:6, log.sql:1', 'Reads: orders.sql:4']);
});

test('T-SQL Find usages: a @variable within its routine; a procedure by its calls', () => {
  assert.deepEqual(rows(tsqlUsages([orders, log], orders.file, orders.text.indexOf('@Total =') + 2)), ['Definitions: orders.sql:1', 'Writes: orders.sql:8', 'Reads: orders.sql:5, orders.sql:8']);
  assert.deepEqual(rows(tsqlUsages([orders, log], log.file, log.text.indexOf('SaveOrder') + 2)), ['Definitions: orders.sql:1', 'Calls: log.sql:3']);
  assert.throws(() => tsqlUsages([orders], orders.file, orders.text.indexOf('WHERE') + 1), /Put the cursor on a table/);
});

test('T-SQL Callers and calls: EXEC and function calls across files, and procedures outside the workspace', () => {
  const report = tsqlCallGraph([orders, log], orders.file, orders.text.indexOf('DECLARE'), { depth: 3, direction: 'both' });
  assert.equal(report.title, 'Call graph of dbo.SaveOrder');
  assert.deepEqual(report.roots.map((r) => [r.label, r.children?.map((c) => c.label)]), [['Called by', ['dbo.Nightly']], ['Calls', ['dbo.LogChange', 'dbo.Fee']]]);
  const nightly = tsqlCallGraph([orders, log], log.file, log.text.indexOf('Nightly'), { depth: 1, direction: 'callees' });
  assert.deepEqual(nightly.roots[0].children?.map((c) => `${c.label} ${c.description}`), ['dbo.SaveOrder procedure · orders.sql:1', 'sp_who not in this workspace']);
});

test('T-SQL statements: CASE … ELSE … END, WITH cte … UPDATE … SET … JOIN stay whole, and a JOIN is not a missing WHERE', () => {
  const code = `CREATE PROC p AS
BEGIN
  WITH recent AS (SELECT Id FROM dbo.Orders) UPDATE o SET Flag = 1 FROM dbo.Orders o JOIN recent r ON r.Id = o.Id;
  SELECT CASE WHEN COUNT(*) > 0 THEN 'some' ELSE 'none' END FROM #work
END`;
  const [routine] = routines(code);
  const body = routine.body[0].statements!.map((s) => code.slice(s.start, s.end).replace(/\s+/g, ' '));
  assert.deepEqual(body, ['WITH recent AS (SELECT Id FROM dbo.Orders) UPDATE o SET Flag = 1 FROM dbo.Orders o JOIN recent r ON r.Id = o.Id', "SELECT CASE WHEN COUNT(*) > 0 THEN 'some' ELSE 'none' END FROM #work"]);
  assert.ok(!inspectTsql(code).some((f) => f.inspection === 'tsqlUpdateWithoutWhere'));
});

test('T-SQL Find usages: a cursor just before a name (dbo.|Orders) means the name', () => {
  const report = tsqlUsages([orders], orders.file, orders.text.indexOf('Orders WHERE'));
  assert.equal(report.title, 'Usages of Orders');
});
