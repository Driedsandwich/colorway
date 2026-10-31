// The ColorWay page decides per surface when a result is ready, so the view must carry that per surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import { colorwayView } from '../lib/colorway.mjs';

test('colorwayView: a saved surface reports success with its image while another surface is still saving', () => {
  const jobs = new Map([
    ['job-nail', { id: 'job-nail', feature: 'nail', status: 'success',
      results: [{ name: 'result.png', contentType: 'image/png', url: '/api/results/job-nail/result.png' },
        { name: 'metadata.json', contentType: 'application/json', url: '/api/results/job-nail/metadata.json' }] }],
    ['job-lip', { id: 'job-lip', feature: 'makeup', status: 'saving' }],
  ]);
  const colorway = { id: 'cw', color: '#C8102E', createdAt: '2026-10-23T00:00:00.000Z',
    jobs: [{ name: 'nail', jobId: 'job-nail', color: '#C8102E' }, { name: 'lip', jobId: 'job-lip', color: '#C8102E' }] };
  const view = colorwayView(colorway, jobs);
  assert.equal(view.status, 'running');
  assert.equal(view.surfaces.nail.status, 'success');
  assert.deepEqual(view.surfaces.nail.results.map(file => file.name), ['result.png']);
  assert.equal(view.surfaces.lip.status, 'saving');
  assert.deepEqual(view.surfaces.lip.results, []);
});
