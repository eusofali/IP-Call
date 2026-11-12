(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const csrf = document.querySelector('meta[name=csrf]')?.content;

  // Mobile sidebar
  $('.menu-btn')?.addEventListener('click', () => document.body.classList.toggle('nav-open'));
  document.addEventListener('click', (e) => {
    if (document.body.classList.contains('nav-open') && !e.target.closest('.sidebar,.menu-btn')) document.body.classList.remove('nav-open');
    // close user menu when clicking elsewhere
    $$('details.userbox[open]').forEach((d) => { if (!d.contains(e.target)) d.removeAttribute('open'); });
  });

  // Confirm before destructive actions: <form data-confirm="Delete?">
  document.addEventListener('submit', (e) => {
    const msg = e.target.dataset.confirm;
    if (msg && !confirm(msg)) e.preventDefault();
  });

  // Dialogs: <button data-dialog="id" data-fill='{"name":"x"}' data-action="/url">
  document.addEventListener('click', (e) => {
    const opener = e.target.closest('[data-dialog]');
    if (opener) {
      const d = document.getElementById(opener.dataset.dialog);
      if (!d) return;
      const form = $('form', d);
      if (form && opener.dataset.action) form.action = opener.dataset.action;
      if (form && opener.dataset.fill) {
        const data = JSON.parse(opener.dataset.fill);
        for (const [k, v] of Object.entries(data)) {
          const el = form.elements[k];
          if (!el) continue;
          if (el.type === 'checkbox') el.checked = !!Number(v) || v === true;
          else el.value = v ?? '';
        }
      }
      if (opener.dataset.title) $('.d-head h3', d).textContent = opener.dataset.title;
      d.showModal();
    }
    if (e.target.closest('[data-close]')) e.target.closest('dialog').close();

    // Reveal secrets: <span class="secret" data-secret="..."><span class="val">•••</span><button data-reveal>
    const rev = e.target.closest('[data-reveal]');
    if (rev) {
      const box = rev.closest('.secret');
      const val = $('.val', box);
      const shown = box.classList.toggle('shown');
      val.textContent = shown ? box.dataset.secret : '•'.repeat(12);
      rev.innerHTML = `<i class="bi bi-eye${shown ? '-slash' : ''}"></i>`;
    }
    // Copy: <button data-copy="text">
    const cp = e.target.closest('[data-copy]');
    if (cp) {
      navigator.clipboard?.writeText(cp.dataset.copy).then(() => {
        const old = cp.innerHTML; cp.innerHTML = '<i class="bi bi-check2"></i>'; setTimeout(() => (cp.innerHTML = old), 1200);
      });
    }
    // Tabs filter: <div class="tabs" data-target=".apps"> <button data-tab="android">
    const tab = e.target.closest('.tabs [data-tab]');
    if (tab) {
      const wrap = tab.closest('.tabs');
      $$('[data-tab]', wrap).forEach((b) => b.classList.toggle('on', b === tab));
      $$(wrap.dataset.target + ' [data-kind]').forEach((el) => el.classList.toggle('hidden', tab.dataset.tab !== 'all' && el.dataset.kind !== tab.dataset.tab));
    }
  });

  // Select-all checkboxes: <input type=checkbox data-check-all="name">
  $$('[data-check-all]').forEach((all) => all.addEventListener('change', () => {
    $$(`input[type=checkbox][name="${all.dataset.checkAll}"]`).forEach((c) => (c.checked = all.checked));
  }));

  // Show/hide blocks: <input data-toggle="#sel">
  $$('[data-toggle]').forEach((el) => {
    const apply = () => $$(el.dataset.toggle).forEach((t) => t.classList.toggle('hidden', !(el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value)));
    el.addEventListener('change', apply);
    if (el.type === 'radio') $$(`input[name="${el.name}"]`).forEach((r) => r.addEventListener('change', apply));
    apply();
  });

  // Auto-submit on change: <form data-autosubmit>
  $$('form[data-autosubmit] [data-auto]').forEach((el) => el.addEventListener('change', () => el.form.requestSubmit()));

  // ARI connection test: <button data-test-ari="/install/test-ari">
  $$('[data-test-ari]').forEach((btn) => btn.addEventListener('click', async () => {
    const f = btn.form;
    const out = $('#ari-result');
    out.className = 'hint'; out.textContent = 'Testing…';
    try {
      const r = await fetch(btn.dataset.testAri, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ url: f.ariUrl.value, user: f.ariUser.value, pass: f.ariPass.value }),
      }).then((x) => x.json());
      out.style.color = r.ok ? 'var(--green)' : 'var(--red)';
      out.textContent = (r.ok ? '✔ ' : '✖ ') + r.message;
    } catch (e) { out.style.color = 'var(--red)'; out.textContent = '✖ ' + e.message; }
  }));

  // IVR option rows
  const optTpl = $('#opt-tpl');
  $('#add-opt')?.addEventListener('click', () => {
    $('#opts').insertAdjacentHTML('beforeend', optTpl.innerHTML);
    syncOptRows();
  });
  document.addEventListener('click', (e) => { if (e.target.closest('[data-remove-row]')) e.target.closest('tr').remove(); });
  function syncOptRows() {
    $$('#opts tr').forEach((tr) => {
      const act = $('select[name=action]', tr).value;
      $$('[data-for]', tr).forEach((el) => {
        const on = el.dataset.for.split(' ').includes(act);
        el.classList.toggle('hidden', !on);
        el.disabled = !on;
      });
    });
  }
  document.addEventListener('change', (e) => { if (e.target.matches('#opts select[name=action]')) syncOptRows(); });
  if ($('#opts')) syncOptRows();
  // Before submit, make sure each row sends exactly one "target" (the visible one).
  $('#ivr-form')?.addEventListener('submit', () => {
    $$('#opts tr').forEach((tr) => {
      const vis = $$('[data-for]', tr).find((el) => !el.disabled);
      $$('[data-for]', tr).forEach((el) => el.removeAttribute('name'));
      let h = $('input[data-target-hidden]', tr);
      if (!h) { h = document.createElement('input'); h.type = 'hidden'; h.dataset.targetHidden = '1'; tr.appendChild(h); }
      h.name = 'target'; h.value = vis ? vis.value : '';
    });
  });

  // Live calls (dashboard + monitoring)
  const live = $('[data-live]');
  if (live) {
    const tbody = $('tbody', live);
    const count = $$('[data-live-count]');
    const queued = $('[data-live-queued]');
    const wallet = $('.wallet .amt');
    let skew = 0;
    const dur = (since) => {
      if (!since) return '—';
      const s = Math.max(0, Math.floor((Date.now() - skew - new Date(since).getTime()) / 1000));
      return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    const badge = { dialing: 'b-blue', ringing: 'b-amber', answered: 'b-green' };
    let data = [];
    const render = () => {
      count.forEach((c) => (c.textContent = data.length));
      if (!data.length) {
        tbody.innerHTML = `<tr><td colspan="7"><div class="empty"><i class="bi bi-telephone-x"></i>No active calls</div></td></tr>`;
        return;
      }
      tbody.innerHTML = data.map((c, i) => `<tr><td>${i + 1}</td><td>${c.direction === 'in' ? '<i class="bi bi-telephone-inbound"></i> In' : '<i class="bi bi-telephone-outbound"></i> Out'}</td>
        <td>${c.from}</td><td>${c.to}</td><td><span class="badge ${badge[c.status] || 'b-gray'}"><span class="dot ${c.status === 'answered' ? '' : 'pulse'}"></span>${c.status}</span></td>
        <td class="mono">${c.status === 'answered' ? dur(c.since) : '—'}</td>
        <td class="actions"><button class="ib r" title="Hang up" data-hangup="${c.id}"><i class="bi bi-telephone-x"></i></button></td></tr>`).join('');
    };
    const poll = async () => {
      try {
        const r = await fetch('/live', { headers: { Accept: 'application/json' } });
        if (r.redirected || !r.ok) return;
        const j = await r.json();
        skew = Date.now() - j.serverTime;
        data = j.calls;
        if (queued) queued.textContent = j.queued;
        if (wallet && window.fmtMoney) wallet.textContent = window.fmtMoney(j.balance);
        render();
      } catch { /* offline */ }
    };
    live.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-hangup]');
      if (!b || !confirm('Hang up this call?')) return;
      await fetch(`/calls/${b.dataset.hangup}/hangup`, { method: 'POST', headers: { 'x-csrf-token': csrf, 'Content-Type': 'application/json' }, body: '{}' });
      poll();
    });
    poll();
    setInterval(poll, 3000);
    setInterval(render, 1000);
  }
})();
