import test from 'node:test';
import assert from 'node:assert/strict';
import { CalibrationRidge } from '../dist/regression.mjs';
import { pointsFor, DisplayStabilizer, summarize } from '../dist/core.mjs';

function eyeFeatures(x, y, sample = 0) {
  // High-dimensional, correlated appearance features with constant dimensions.
  // Small variation within a target is independent of screen row/order.
  return Array.from({ length: 120 }, (_, i) => {
    const noise = Math.sin((sample + 1) * 17 + i * 1.7) * 0.002;
    return [x, y, x * y, x * x, y * y, 0.5][i % 6] + noise;
  });
}

function trained(order = pointsFor('calibration', 1000, 700), count = () => 20) {
  const model = new CalibrationRidge();
  for (const point of order) {
    for (let i = 0; i < count(point); i++) model.addData(eyeFeatures(point.x / 1000, point.y / 700, i), [point.x, point.y]);
  }
  model.fit({ width: 1000, height: 700 });
  return model;
}

test('all nine screen positions survive more than 50 row-ordered samples', () => {
  const model = trained();
  const diagnostics = model.diagnostics();
  assert.equal(diagnostics.retainedSamples, 180);
  assert.equal(diagnostics.targetCount, 9);
  assert.ok(diagnostics.targets.every(target => target.samples === 20));
  assert.equal(new Set(diagnostics.targets.map(target => target.y)).size, 3);
  const upperLeft = model.predict(eyeFeatures(0.1, 0.1));
  const lowerRight = model.predict(eyeFeatures(0.9, 0.9));
  assert.ok(upperLeft.x < 200 && upperLeft.y < 140);
  assert.ok(lowerRight.x > 800 && lowerRight.y > 560);
});

test('independent positions cover the full screen without a bottom-row collapse', () => {
  const model = trained();
  const targets = pointsFor('validation', 1000, 700);
  const samples = targets.map(target => {
    const prediction = model.predict(eyeFeatures(target.x / 1000, target.y / 700, 37));
    return { ...prediction, targetId: target.id, targetX: target.x, targetY: target.y, valid: true };
  });
  const stats = summarize(samples, targets, 1000, 700);
  assert.equal(stats.gridHitRate, 1);
  assert.ok(stats.p90ErrorPx < 25, `Independent synthetic error: ${stats.p90ErrorPx}`);
});

test('reversing calibration order does not shift predictions into the last row', () => {
  const order = pointsFor('calibration', 1000, 700);
  const forward = trained(order);
  const reverse = trained([...order].reverse());
  for (const point of pointsFor('validation', 1000, 700)) {
    const features = eyeFeatures(point.x / 1000, point.y / 700, 33);
    const a = forward.predict(features);
    const b = reverse.predict(features);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-6);
  }
});

test('per-target memory bounds never evict another target; weighting handles unequal sample counts', () => {
  const model = trained(undefined, point => point.id < 7 ? 8 : 90);
  assert.equal(model.diagnostics().targetCount, 9);
  assert.equal(model.diagnostics().retainedSamples, 6 * 8 + 3 * 32);
  const middle = model.predict(eyeFeatures(0.5, 0.5));
  assert.ok(Math.hypot(middle.x - 500, middle.y - 350) < 15);
});

test('calibration fits once and prediction/testing cannot alter the model', () => {
  const model = trained();
  const before = model.diagnostics();
  for (let i = 0; i < 100; i++) model.predict(eyeFeatures(0.2, 0.2, i));
  assert.equal(model.addData(eyeFeatures(0.9, 0.9), [900, 630]), false);
  assert.deepEqual(model.diagnostics(), before);
  assert.equal(model.fitCount, 1);
  assert.equal(model.predict(null), null);
  assert.equal(model.predict(Array(120).fill(NaN)), null);
});

test('incomplete calibration fails; reset clears all prior session features', () => {
  const model = new CalibrationRidge();
  assert.equal(model.predict(eyeFeatures(0.5, 0.5)), null);
  for (let i = 0; i < 20; i++) model.addData(eyeFeatures(0.5, 0.5, i), [500, 350]);
  assert.throws(() => model.fit({ width: 1000, height: 700 }), /校准位置/);
  model.init();
  assert.equal(model.diagnostics().retainedSamples, 0);
  assert.equal(model.frozen, false);
  assert.deepEqual(model.getData(), []);
});

test('display removes an isolated jump, accepts sustained movement and resets on loss', () => {
  const filter = new DisplayStabilizer();
  filter.push({ x: 10, y: 10 }, 0);
  filter.push({ x: 12, y: 10 }, 100);
  assert.deepEqual(filter.push({ x: 1000, y: -1000 }, 200), { x: 12, y: 10 });
  assert.deepEqual(filter.push({ x: 1000, y: -1000 }, 300), { x: 1000, y: -1000 });
  assert.equal(filter.push(null, 400), null);
  assert.deepEqual(filter.push({ x: 500, y: 300 }, 500), { x: 500, y: 300 });
  assert.deepEqual(filter.push({ x: 100, y: 100 }, 2000), { x: 100, y: 100 });
});
