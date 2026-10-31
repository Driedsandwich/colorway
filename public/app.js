const $ = (selector) => document.querySelector(selector);

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (response.status === 401 && document.body.dataset.page === 'app') {
    location.assign('/');
    throw new Error('Your session has expired. Sign in again.');
  }
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `Request failed (${response.status}).`);
  return data;
}

function setStatus(element, message, error = false) {
  element.textContent = message;
  element.classList.toggle('error', error);
}

if (document.body.dataset.page === 'login') {
  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    setStatus($('#login-status'), 'Signing in…');
    try {
      await api('/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: $('#passcode').value }),
      });
      $('#passcode').value = '';
      location.assign('/colorway');
    } catch (error) {
      setStatus($('#login-status'), error.message, true);
      button.disabled = false;
    }
  });
} else if (document.body.dataset.page === 'app') {
  let mode;
  let features = [];
  let photo;
  let previewUrl;
  let busy = false;
  const form = $('#task-form');
  const status = $('#task-status');
  const controls = $('#task-controls');
  const featureSelect = $('#feature');
  const progress = $('#task-progress');
  const fingers = ['thumb', 'index', 'middle', 'ring', 'little'];
  const supportedHere = new Set(['hair-color', 'nail']);

  function choosePhoto(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 10 * 1024 * 1024 || file.size === 0) {
      event.target.value = '';
      photo = undefined;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = undefined;
      $('#photo-preview').removeAttribute('src');
      $('#photo-preview').hidden = true;
      $('#file-summary').textContent = 'No photo selected.';
      setStatus(status, 'Choose a nonempty JPEG or PNG photo up to 10 MB.', true);
      return;
    }
    photo = file;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    $('#photo-preview').src = previewUrl;
    $('#photo-preview').hidden = false;
    $('#file-summary').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
    setStatus(status, 'Photo ready. Choose your settings and run a test.');
  }

  $('#photo').addEventListener('change', choosePhoto);
  $('#hand-photo').addEventListener('change', choosePhoto);
  window.addEventListener('pagehide', () => { if (previewUrl) URL.revokeObjectURL(previewUrl); });

  function showOptions() {
    const feature = features.find((item) => item.id === featureSelect.value);
    for (const [id, featureId] of [['hair-options', 'hair-color'], ['nail-options', 'nail']]) {
      const fieldset = $(`#${id}`);
      fieldset.hidden = featureSelect.value !== featureId;
      fieldset.disabled = fieldset.hidden;
    }
    if (!feature) {
      $('#feature-note').textContent = 'No feature is available in this mode.';
      $('#run-button').disabled = true;
      return;
    }
    const cost = feature.estimatedUnits == null ? 'Unit cost unverified.' : `Estimated ${feature.estimatedUnits} unit${feature.estimatedUnits === 1 ? '' : 's'} per successful live task.`;
    const verification = typeof feature.verification === 'string' ? feature.verification : '';
    const notes = Array.isArray(feature.notes) ? feature.notes.join(' ') : feature.notes || '';
    $('#feature-note').textContent = [cost, verification ? `Verification: ${verification}.` : '', notes].filter(Boolean).join(' ');
    $('#run-button').disabled = false;
  }

  featureSelect.addEventListener('change', showOptions);

  async function refreshUsage() {
    try {
      const usage = await api('/api/usage');
      const unresolvedUnits = usage.unknownEstimatedUnits > 0 ? ` · ${usage.unknownEstimatedUnits} estimated units with unresolved outcome` : '';
      const unknownUnitCosts = usage.tasksWithUnknownUnitCost > 0 ? ` · ${usage.tasksWithUnknownUnitCost} task(s) with unknown unit cost` : '';
      $('#usage-summary').textContent = `${usage.liveTasks} live tasks · ${usage.successfulTasks} succeeded · ${usage.failedTasks} failed · ${usage.unknownTasks} unresolved · ${usage.estimatedUnits} estimated units${unresolvedUnits}${unknownUnitCosts}`;
    } catch (error) {
      $('#usage-summary').textContent = error.message;
    }
  }

  $('#refresh-usage').addEventListener('click', refreshUsage);

  const statusLabels = {
    queued: 'Waiting for an available task slot…',
    uploading: 'Uploading the photo…',
    running: 'Processing the photo…',
    saving: 'Saving task results…',
    success: 'Result saved. Your test is complete.',
    error: 'The task did not complete.',
  };

  function displayTask(task) {
    $('#task-detail').textContent = `Task ${task.id} · ${task.status}`;
    setStatus(status, task.status === 'error' ? task.error || statusLabels.error : statusLabels[task.status] || 'Checking task status…', task.status === 'error');
    progress.hidden = ['success', 'error'].includes(task.status);
    if (Number.isFinite(task.progress)) progress.value = Math.max(0, Math.min(100, task.progress));
    else progress.removeAttribute('value');
  }

  function displayResults(results) {
    const container = $('#results');
    container.replaceChildren();
    for (const [index, result] of (results || []).entries()) {
      // Results must point to this app's protected storage route.
      const url = new URL(result.url, location.origin);
      if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) continue;
      const figure = document.createElement('figure');
      const caption = document.createElement('figcaption');
      const link = document.createElement('a');
      link.href = url.href;
      link.textContent = `Download stored result ${index + 1}`;
      link.download = '';
      if (result.contentType?.startsWith('image/')) {
        const image = document.createElement('img');
        image.src = url.href;
        image.alt = mode === 'mock' ? 'Mock result: the original uploaded photo, unchanged' : `Stored task result ${index + 1}`;
        figure.append(image);
      }
      caption.append(link);
      figure.append(caption);
      container.append(figure);
    }
    $('#result-empty').hidden = container.childElementCount > 0;
    if (!container.childElementCount) $('#result-empty').firstElementChild.nextElementSibling.textContent = 'No displayable stored results were returned.';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!photo) {
      setStatus(status, 'Choose or capture a photo before running a test.', true);
      $('#photo').focus();
      return;
    }
    const featureId = featureSelect.value;
    const values = new FormData(form);
    const options = featureId === 'hair-color'
      ? { colors: [values.get('hair-first'), values.get('hair-second')], ombreLineOffset: Number(values.get('ombre-offset')) }
      : { colors: Object.fromEntries(fingers.map((finger) => [finger, values.get(`nail-${finger}`)])) };
    busy = true;
    controls.disabled = true;
    $('#results').replaceChildren();
    $('#result-empty').hidden = true;
    $('#task-detail').textContent = '';
    progress.hidden = false;
    progress.removeAttribute('value');
    setStatus(status, 'Saving the selected photo…');
    try {
      const { uploadId } = await api('/api/uploads', {
        method: 'POST', headers: { 'Content-Type': photo.type, 'X-File-Name': encodeURIComponent(photo.name) }, body: photo,
      });
      let task = await api('/api/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: featureId, uploadId, options }),
      });
      displayTask(task);
      while (!['success', 'error'].includes(task.status)) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        task = await api(`/api/tasks/${encodeURIComponent(task.id)}`);
        displayTask(task);
      }
      if (task.status === 'success') displayResults(task.results);
    } catch (error) {
      setStatus(status, `${error.message} No task was automatically retried.`, true);
      progress.hidden = true;
    } finally {
      busy = false;
      controls.disabled = false;
      showOptions();
      await refreshUsage();
    }
  });

  async function initialize() {
    try {
      const data = await api('/api/features');
      mode = data.mode;
      features = data.features;
      $('#mode-badge').textContent = mode === 'mock' ? 'Mock mode' : 'Live mode';
      $('#mode-badge').classList.toggle('live', mode === 'live');
      $('#mode-note').textContent = mode === 'mock'
        ? 'Mock mode never contacts YouCam and uses no API units. The result is the uploaded photo, unchanged; feature settings are not applied.'
        : 'Live mode sends the selected photo to YouCam and uses API units. Successful results are downloaded into app storage before they appear here. Hair color remains mock-only until its upload path is verified.';
      for (const feature of features) {
        const option = document.createElement('option');
        option.value = feature.id;
        option.disabled = !supportedHere.has(feature.id) || (mode === 'live' && !feature.liveSupported);
        option.textContent = `${feature.label}${option.disabled ? ' — unavailable on this page' : ''}`;
        featureSelect.append(option);
        const entry = document.createElement('li');
        const notes = Array.isArray(feature.notes) ? feature.notes.join(' ') : feature.notes || '';
        const availability = supportedHere.has(feature.id)
          ? (feature.liveSupported ? 'Live and mock controls available.' : 'Mock controls only; live support is unverified.')
          : 'Controls are not included on this developer page.';
        entry.textContent = `${feature.label}: ${availability} ${notes}`;
        $('#feature-catalog').append(entry);
      }
      const available = [...featureSelect.options].find((option) => !option.disabled);
      if (available) featureSelect.value = available.value;
      else featureSelect.selectedIndex = -1;
      controls.disabled = false;
      showOptions();
      await refreshUsage();
    } catch (error) {
      setStatus(status, error.message, true);
      $('#mode-note').textContent = 'The workspace could not load. Reload the page to try again.';
    }
  }
  initialize();
}
