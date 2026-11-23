import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL, pointsFor, shuffled, TargetClock, gridCell, summarize, trainingAllowed, samplesToCsv } from '../dist/core.mjs';

const sample = (x, y, targetId = 1, targetX = 50, targetY = 50, valid = true) => ({ x, y, targetId, targetX, targetY, valid });

test('validation covers nine regions without reusing calibration positions', () => {
  const calibration = pointsFor('calibration', 1000, 700);
  const validation = pointsFor('validation', 1000, 700);
  assert.equal(new Set(validation.map(p => gridCell(p.x, p.y, 1000, 700))).size, 9);
  assert.ok(validation.every(p => !calibration.some(c => c.x === p.x && c.y === p.y)));
  assert.deepEqual(shuffled(validation, () => 0).map(p => p.id).sort(), validation.map(p => p.id).sort());
});

test('both test grids are disjoint from both calibration grids', () => {
  const calibration = ['calibration','precision'].flatMap(kind=>pointsFor(kind,1000,700));
  const validation = pointsFor('validation16',1000,700);
  assert.equal(validation.length,16);
  assert.equal(new Set(validation.map(p=>gridCell(p.x,p.y,1000,700))).size,9);
  assert.ok([...validation,...pointsFor('validation',1000,700)].every(point=>
    !calibration.some(target=>target.x===point.x&&target.y===point.y)));
});

test('out-of-order timestamps cannot advance the target clock twice', () => {
  const clock = new TargetClock(pointsFor('validation',1000,700),0);
  for(const time of [100,90,110])clock.update(time);
  assert.equal(clock.elapsed,110);
});

test('pixel errors, interpolated quantiles and diagonal percentages use actual distances', () => {
  const stats = summarize([sample(53, 54), sample(50, 60), sample(50, 70)], [{ id: 1, x: 50, y: 50 }], 300, 400);
  assert.equal(stats.medianErrorPx, 10);
  assert.equal(stats.p90ErrorPx, 18);
  assert.equal(stats.medianErrorDiagonalPct, 2);
  assert.ok(Math.abs(stats.p90ErrorDiagonalPct - 3.6) < 1e-12);
});

test('out-of-bounds predictions remain errors and cannot count as grid hits', () => {
  const stats = summarize([sample(-100, 50), sample(1000, 50)], [{ id: 1, x: 50, y: 50 }], 100, 100);
  assert.equal(stats.medianErrorPx, 550);
  assert.equal(stats.gridHitRate, 0);
  assert.equal(stats.validPredictionRate, 1);
});

test('invalid callbacks affect validity, not error distribution; frequency uses capture duration', () => {
  const stats = summarize([sample(53, 54), sample(null, null, 1, 50, 50, false)], [{ id: 1, x: 50, y: 50 }], 100, 100);
  assert.equal(stats.medianErrorPx, 5);
  assert.equal(stats.validPredictionRate, 0.5);
  assert.equal(stats.predictionHz, 0.5);
  assert.equal(stats.validSamples, 1);
});

test('zero samples and nonfinite coordinates do not produce invented scores', () => {
  const targets = [{ id: 1, x: 50, y: 50 }];
  for (const samples of [[], [sample(NaN, Infinity)]]) {
    const stats = summarize(samples, targets, 100, 100);
    assert.equal(stats.medianErrorPx, null);
    assert.equal(stats.gridHitRate, null);
    assert.equal(stats.jitterRmsPx, null);
    assert.equal(stats.targetsWithData, 0);
    assert.equal(stats.predictionHz, 0);
  }
});

test('jitter measures spread around each target mean, not spread across screen targets', () => {
  const targets = [{ id: 1, x: 50, y: 50 }, { id: 2, x: 250, y: 250 }];
  const stats = summarize([sample(47, 46), sample(53, 54), sample(247, 246, 2, 250, 250), sample(253, 254, 2, 250, 250)], targets, 300, 300);
  assert.equal(stats.jitterRmsPx, 5);
});

test('isolated single-sample targets cannot establish a jitter estimate', () => {
  const stats = summarize([sample(50, 50), sample(250, 250, 2, 250, 250)], [{ id: 1, x: 50, y: 50 }, { id: 2, x: 250, y: 250 }], 300, 300);
  assert.equal(stats.jitterRmsPx, null);
});

test('grid boundaries and viewport edges have consistent hit semantics', () => {
  assert.equal(gridCell(0, 0, 300, 300), 0);
  assert.equal(gridCell(100, 100, 300, 300), 4);
  assert.equal(gridCell(299.9, 299.9, 300, 300), 8);
  for (const [x, y] of [[300, 10], [10, 300], [-1, 20], [NaN, 0]]) assert.equal(gridCell(x, y, 300, 300), -1);
});

test('calibration cannot progress while detection is paused or sampling is insufficient', () => {
  const clock = new TargetClock([{ id: 1 }, { id: 2 }], 0);
  clock.update(1000, false);
  assert.equal(clock.elapsed, 0);
  clock.update(2000, true);
  assert.equal(clock.capturing, true);
  clock.update(4000, true, false);
  assert.equal(clock.index, 0);
  clock.update(4100, true, true);
  assert.equal(clock.index, 1);
  assert.equal(clock.capturing, false);
  clock.update(7100);
  assert.equal(clock.done, true);
});

test('only explicit calibration capture permits training', () => {
  for (const mode of ['idle', 'practice', 'baseline', 'motion']) {
    assert.equal(trainingAllowed(mode, true, true), false);
  }
  assert.equal(trainingAllowed('calibration', false, true), false);
  assert.equal(trainingAllowed('calibration', true, false), false);
  assert.equal(trainingAllowed('calibration', true, true), true);
  assert.equal(PROTOCOL.settleMs + PROTOCOL.captureMs, 3000);
});

test('CSV preserves missing predictions, zero coordinates and escaped values', () => {
  const csv = samplesToCsv([{ roundId: 'a,"b', condition: 'baseline', x: 0, y: null, valid: false }]);
  assert.ok(csv.startsWith('\uFEFFroundId,'));
  assert.ok(csv.includes('"a,""b",baseline'));
  assert.ok(csv.includes(',0,,false,'));
  assert.ok(!csv.includes('null'));
});
