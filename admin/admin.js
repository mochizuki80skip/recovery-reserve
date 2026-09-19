(function () {
  'use strict';

  const STORAGE_KEY = 'recovery-admin-pass';

  function $(id) { return document.getElementById(id); }

  function showAuthView() {
    $('login-card').hidden = true;
    $('auth-view').hidden = false;
    applyKindUI();
    refreshTargetCourseOptions();
    bindPromoFilters();
    bindAdminNav();
    bindCustomerUiOnce();
    showSection(sessionStorage.getItem(SECTION_KEY) || 'home');
    loadPromos();
    loadStats();
    loadTemplates();
    loadCustomersCachedForHome();
  }
  let _churnBound = false;
  function bindCustomerUiOnce() { if (_churnBound) return; _churnBound = true; bindCustomerUi(); }

  // ---- メニュー（左メニュー / スマホはピル型タブ）----
  const SECTION_KEY = 'recovery-admin-section';
  const SECTIONS = {
    home: { title: 'ホーム', help: '離反リスト・キャンペーン・Threease との通信状況をまとめて確認できます。' },
    retention: { title: '離反対策リスト', help: '最終来院から60日以内の既存のお客様。次回予約が無い方に早めにご案内します。' },
    churn: { title: '離反リスト', help: '最終来院から60日以上あいていて次回予約が無いお客様。連絡する文面をその場で作れます。' },
    stats: { title: '継続率・離反率', help: '新規のお客様が何回目まで続いているか、担当スタッフごとに見ます。' },
    campaigns: { title: 'キャンペーン管理', help: 'チラシや紹介用の限定メニューを登録し、専用URL（?promo=コード）を発行します。' },
    log: { title: '通信ログ', help: 'お客様向けサイトが Threease を読みに行った回数・成功率・キャッシュ率（直近3日）。' },
  };

  function showSection(name) {
    if (!SECTIONS[name]) name = 'home';
    document.querySelectorAll('.admin-section').forEach((s) => { s.hidden = s.dataset.section !== name; });
    document.querySelectorAll('.nav-item[data-section]').forEach((b) => { b.classList.toggle('is-active', b.dataset.section === name); });
    const t = $('admin-title'); if (t) t.textContent = SECTIONS[name].title;
    const h = $('admin-help-text'); if (h) h.textContent = SECTIONS[name].help;
    sessionStorage.setItem(SECTION_KEY, name);
    window.scrollTo({ top: 0 });
    if (LIST_SECTIONS.includes(name)) loadCustomers(cust.clinic);
  }

  let _adminNavBound = false;
  function bindAdminNav() {
    if (_adminNavBound) return;
    _adminNavBound = true;
    document.querySelectorAll('.nav-item[data-section]').forEach((btn) => {
      btn.addEventListener('click', () => showSection(btn.dataset.section));
    });
    // ホームのショートカット（data-goto）。data-focus があればその入力欄へ
    document.querySelectorAll('[data-goto]').forEach((btn) => {
      btn.addEventListener('click', () => {
        showSection(btn.dataset.goto);
        if (btn.dataset.focus) {
          const el = $(btn.dataset.focus);
          if (el) setTimeout(() => { el.focus(); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 50);
        }
      });
    });
  }

  // ---- ホーム ----
  function renderHome() {
    renderHomeChurn();
    const items = window.__lastPromoItems || null;
    const statsBox = $('home-promo-stats');
    const recentBox = $('home-promo-recent');
    if (statsBox && items) {
      const counts = { override: 0, shortcut: 0, addon: 0, auto: 0, newLine: 0 };
      for (const p of items) { counts[detectKind(p)]++; if (p.autoOpen) counts.auto++; if (p.useNewCustomerLine) counts.newLine++; }
      statsBox.innerHTML = `
        <div class="home-stat"><div class="home-stat-num"><b>${items.length}</b><span>件</span></div><small>登録中のキャンペーン<br><b>${counts.override}</b> 価格上書き ／ <b>${counts.shortcut}</b> 直行 ／ <b>${counts.addon}</b> 新メニュー</small></div>
        <div class="home-stat"><div class="home-stat-num"><b>${counts.auto}</b><span>件</span></div><small>URLを開くと自動入力されるもの</small></div>
        <div class="home-stat"><div class="home-stat-num"><b>${counts.newLine}</b><span>件</span></div><small>初回予約を新規集客用LINEに送るもの</small></div>`;
      const recent = items.slice(0, 3);
      recentBox.innerHTML = recent.length
        ? recent.map((p) => {
          const kind = detectKind(p);
          const title = buildPromoTitle(p, kind, findCourseNameSync(p.targetCourseId, p.forClinic, p.forFirstTime));
          return `<div class="home-recent-item k-${kind}"><span class="t">${escapeHtml(title)}</span><span class="c">?promo=${escapeHtml(p.code)}</span></div>`;
        }).join('')
        : '<p class="admin-help">まだキャンペーンはありません。「キャンペーン管理」から追加できます。</p>';
    }
    const st = window.__lastStats;
    const box = $('home-stats');
    if (box && st) {
      const days = Object.keys(st).sort().reverse();
      const day = days[0];
      const c = day ? (st[day].courses || {}) : null;
      if (!c || !c.total) {
        box.innerHTML = '<p class="admin-help">まだ今日の計測データがありません。</p>';
      } else {
        const rate = c.successRate == null ? 'good' : c.successRate >= 99 ? 'good' : c.successRate >= 95 ? 'warn' : 'bad';
        box.innerHTML = `
          <div class="home-stat"><div class="home-stat-num"><b>${c.total.toLocaleString()}</b><span>回</span></div><small>問い合わせ数（${escapeHtml(day)}）</small></div>
          <div class="home-stat"><div class="home-stat-num ${rate}"><b>${c.successRate != null ? c.successRate : '-'}</b><span>%</span></div><small>Threease 読み込みの成功率</small></div>
          <div class="home-stat"><div class="home-stat-num"><b>${c.cacheHitRate != null ? c.cacheHitRate : '-'}</b><span>%</span></div><small>キャッシュ率（高いほど軽い）</small></div>`;
      }
    }
  }

  // ---- お客様データ（離反対策リスト・離反リスト・継続率/離反率） ----
  const CLINICS = {
    '192': { name: '長泉三島院', phone: '055-950-8703' },
    '193': { name: '裾野長泉院', phone: '055-993-6877' },
  };
  const DEFAULT_TEMPLATES = [
    { id: 'osashiburi', name: 'お久しぶりのご様子うかがい', body:
`{name}様

リカバリー鍼灸院 {clinic}です。
前回のご来院（{last}）から{elapsed}日ほど経ちましたが、その後お身体の調子はいかがでしょうか。

季節の変わり目は、肩こりや腰の重さ、疲れが抜けにくいといった不調が出やすい時期です。
気になることがあれば、お気軽にご相談ください。

ご予約は公式LINEまたはお電話（{phone}）で承ります。
空き状況はこちらからご覧いただけます。
{url}

リカバリー鍼灸院 {clinic}` },
    { id: 'maintenance', name: '定期メンテナンスのご案内', body:
`{name}様

リカバリー鍼灸院 {clinic}です。
前回のご来院から{elapsed}日が経ちました。

施術で整えたお身体も、日々の生活の中で少しずつ元の状態に戻っていきます。
つらくなる前の定期的なメンテナンスが、良い状態を長く保つコツです。

ご都合の良い日があれば、公式LINEまたはお電話（{phone}）でお知らせください。
空き状況はこちらです。
{url}

リカバリー鍼灸院 {clinic}` },
    { id: 'nextvisit', name: '次回のご案内（既存の方）', body:
`{name}様

リカバリー鍼灸院 {clinic}です。先日はご来院ありがとうございました。
前回（{last}）の施術の状態を保つため、次回は2〜3週間以内のご来院をおすすめしています。

ご都合の良い日時があれば、公式LINEまたはお電話（{phone}）でお知らせください。
空き状況はこちらからご覧いただけます。
{url}

リカバリー鍼灸院 {clinic}` },
    { id: 'short', name: '短い声かけ', body:
`{name}様、リカバリー鍼灸院 {clinic}です。
前回（{last}）から{elapsed}日ほど経ちましたが、その後お身体はいかがですか？
気になることがあればいつでもご連絡ください。ご予約はこちらから → {url}` },
  ];
  const LIST_SECTIONS = ['retention', 'churn', 'stats'];

  const cust = {
    clinic: '192', data: {}, loading: {}, templates: null, selected: null, templateId: null,
    filters: { retNext: 'none', retMin: 0, churnRange: '60-90', statsMonths: 6 },
  };

  function fmtMD(ymd) { return ymd ? `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}` : ''; }
  function fmtBuiltAt(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function daysBetween(a, b) { return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000); }
  function addDays(ymd, n) { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function addMonths(ymd, n) { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }
  function currentSection() { return sessionStorage.getItem(SECTION_KEY) || 'home'; }

  async function loadCustomers(clinic, { force = false } = {}) {
    cust.clinic = clinic;
    document.querySelectorAll('.clinic-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.clinic === clinic));
    if (cust.data[clinic] && !force) { renderCustomerViews(); return; }
    if (cust.loading[clinic]) return;
    cust.loading[clinic] = true;
    renderCustomerViews();
    try {
      let r = force ? null : await apiFetch(`/api/admin/customers?clinic=${clinic}&cached=1`).then((x) => x.json());
      if (!r || !r.data) {
        setCustStatus('Threease から読み込み中…（15〜40秒かかります）');
        r = await apiFetch(`/api/admin/customers?clinic=${clinic}${force ? '&force=1' : ''}`).then((x) => x.json());
      }
      if (r.error) throw new Error(r.message || r.error);
      cust.data[clinic] = r.data;
    } catch (e) {
      if (e && e.message !== 'unauthorized') cust.data[clinic] = { error: (e && e.message) || String(e) };
    } finally {
      cust.loading[clinic] = false;
      renderCustomerViews();
      renderHome();
    }
  }

  function setCustStatus(text) {
    document.querySelectorAll('.cust-status-text').forEach((el) => { el.textContent = text; });
  }

  // 経過日数つきの行（today はスナップショットの日付ではなく今日で計算する）
  function rowsWithElapsed(d) {
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    return d.rows.map((r) => ({ ...r, elapsed: r.last ? daysBetween(r.last, today) : null, today }));
  }
  function retentionRows(d) {
    const f = cust.filters;
    return rowsWithElapsed(d)
      .filter((r) => r.elapsed != null && r.elapsed < 60 && r.elapsed >= Number(f.retMin))
      .filter((r) => f.retNext === 'all' ? true : f.retNext === 'has' ? !!r.next : !r.next)
      .sort((a, b) => b.elapsed - a.elapsed || a.kana.localeCompare(b.kana, 'ja'));
  }
  function churnRows(d) {
    const [lo, hi] = cust.filters.churnRange.split('-').map(Number);
    return rowsWithElapsed(d)
      .filter((r) => r.elapsed != null && !r.next && r.elapsed >= lo && r.elapsed <= hi)
      .sort((a, b) => a.elapsed - b.elapsed || a.kana.localeCompare(b.kana, 'ja'));
  }

  function renderCustomerViews() {
    const clinic = cust.clinic;
    const d = cust.data[clinic];
    const lists = document.querySelectorAll('.cust-list');
    if (cust.loading[clinic] && !d) {
      lists.forEach((l) => { l.innerHTML = '<p class="admin-help">読み込み中…</p>'; });
      $('stats-tables').innerHTML = '<p class="admin-help">読み込み中…</p>';
      setCustStatus('読み込み中…');
      return;
    }
    if (!d) return;
    if (d.error) {
      lists.forEach((l) => { l.innerHTML = `<p class="admin-error">取得できませんでした: ${escapeHtml(d.error)}</p>`; });
      $('stats-tables').innerHTML = '';
      setCustStatus('');
      return;
    }
    setCustStatus(`Threease 読み込み ${fmtBuiltAt(d.builtAt)}（毎朝 9時ごろ自動・${d.stats.total.toLocaleString()}人中 直近${d.keepDays}日以内 ${d.stats.kept.toLocaleString()}人）`);
    renderList('retention', retentionRows(d), (r) => r.elapsed >= 45);
    renderList('churn', churnRows(d), (r) => r.elapsed <= 67);
    renderStats(d);
  }

  function renderList(kind, rows, isHot) {
    const list = document.querySelector(`.cust-list[data-list="${kind}"]`);
    if (!list) return;
    if (!rows.length) { list.innerHTML = '<div class="churn-empty">該当するお客様はいません</div>'; return; }
    const hot = rows.filter(isHot).length;
    const hotLabel = kind === 'retention' ? '45日以上' : '60日を超えて1週間以内';
    let html = `<p class="churn-summary"><b>${rows.length}</b> 人${hot ? `（うち ${hotLabel}: <b>${hot}</b> 人）` : ''}</p>`;
    for (const r of rows) {
      const cls = ['churn-row'];
      if (cust.selected && cust.selected.id === r.id) cls.push('is-selected');
      if (isHot(r)) cls.push('is-soon');
      const next = r.next ? `次回予約 <b>${fmtMD(r.next)}</b>` : '<span class="no-next">次回予約なし</span>';
      html += `<div class="${cls.join(' ')}" data-id="${r.id}">
        <div class="churn-name">${escapeHtml(r.name || '(名前なし)')} 様 <small>カルテ ${escapeHtml(r.code || '-')}</small></div>
        <button type="button" class="admin-btn-mini" data-compose="${r.id}">文面を作る</button>
        <div class="churn-meta">最終来院 <b>${fmtMD(r.last)}</b>（<span class="elapsed">${r.elapsed}日</span> 経過）／ ${next} ／ 来院 <b>${r.count}</b> 回${r.ls ? ` ／ 担当 ${escapeHtml(r.ls)}` : ''}${r.first ? ` ／ 初回 ${fmtMD(r.first)}${r.fs ? `（${escapeHtml(r.fs)}）` : ''}` : ''}${r.sym && r.sym.length ? `<br>症状: ${escapeHtml(r.sym.join('・'))}` : ''}</div>
      </div>`;
    }
    list.innerHTML = html;
    list.querySelectorAll('button[data-compose]').forEach((b) => {
      b.addEventListener('click', () => openCompose(rows.find((r) => String(r.id) === b.dataset.compose), kind));
    });
  }

  // ---- 継続率・離反率 ----
  function pct(n, d) { return d ? Math.round((n / d) * 1000) / 10 : null; }
  function pctCell(n, d) {
    const p = pct(n, d);
    if (p == null) return '<td class="num muted">–</td>';
    const cls = p >= 70 ? 'good' : p >= 40 ? 'warn' : 'bad';
    return `<td class="num ${cls}">${p}%<small>${n}</small></td>`;
  }
  function groupBy(rows, key) {
    const m = new Map();
    for (const r of rows) { const k = r[key] || '（担当なし）'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }
  function continuationTable(rows, key, title) {
    const visits = (r) => Math.max(0, r.count - (r.next ? 1 : 0));
    const line = (label, list) => `<tr><th>${escapeHtml(label)}</th><td class="num">${list.length}</td>${[2, 3, 4, 5, 6].map((k) => pctCell(list.filter((r) => visits(r) >= k).length, list.length)).join('')}</tr>`;
    return `<div class="stats-block"><h3>${escapeHtml(title)}</h3>
      <div class="stats-table-wrap"><table class="stats-table"><thead><tr><th>担当</th><th>新規</th><th>2回目</th><th>3回目</th><th>4回目</th><th>5回目</th><th>6回目</th></tr></thead>
      <tbody>${line('全体', rows)}${groupBy(rows, key).map(([k, list]) => line(k, list)).join('')}</tbody></table></div></div>`;
  }
  function churnTable(rows, key, title) {
    const line = (label, list) => { const churned = list.filter((r) => !r.next).length; const p = pct(churned, list.length); const cls = p == null ? 'muted' : p <= 30 ? 'good' : p <= 50 ? 'warn' : 'bad';
      return `<tr><th>${escapeHtml(label)}</th><td class="num">${list.length}</td><td class="num">${churned}</td><td class="num ${cls}">${p == null ? '–' : p + '%'}</td></tr>`; };
    return `<div class="stats-block"><h3>${escapeHtml(title)}</h3>
      <div class="stats-table-wrap"><table class="stats-table"><thead><tr><th>担当</th><th>対象</th><th>離反</th><th>離反率</th></tr></thead>
      <tbody>${line('全体', rows)}${groupBy(rows, key).map(([k, list]) => line(k, list)).join('')}</tbody></table></div></div>`;
  }
  function renderStats(d) {
    const box = $('stats-tables');
    if (!box) return;
    const rows = rowsWithElapsed(d);
    const today = rows[0] ? rows[0].today : new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const from = addMonths(today, -Number(cust.filters.statsMonths));
    const judged = addDays(today, -60);
    const cohort = rows.filter((r) => r.first && r.first >= from && r.first <= judged);
    const existing = rows.filter((r) => r.last && r.last >= from && r.last <= judged);
    box.innerHTML = `<p class="churn-summary">対象: 初回来院 ${fmtMD(from)}〜${fmtMD(judged)} の新規 <b>${cohort.length}</b> 人 ／ 最終来院が同期間のお客様 <b>${existing.length}</b> 人（${fmtMD(judged)} 以降に来た方は判定できないため除外）</p>`
      + continuationTable(cohort, 'fs', '継続率（初回担当スタッフ別）')
      + continuationTable(cohort, 'ls', '継続率（最終担当スタッフ別）')
      + churnTable(existing, 'ls', '離反率（最終担当スタッフ別）');
  }

  // ---- 文面 ----
  function getTemplates() { return cust.templates && cust.templates.length ? cust.templates : DEFAULT_TEMPLATES; }
  async function loadTemplates() {
    try {
      const r = await apiFetch('/api/admin/settings');
      if (!r.ok) return;
      const d = await r.json();
      cust.templates = (d.settings && d.settings.churnTemplates && d.settings.churnTemplates.length) ? d.settings.churnTemplates : null;
    } catch { /* 既定を使う */ }
  }
  function fillTemplate(body, person) {
    const c = CLINICS[cust.clinic] || { name: '', phone: '' };
    return String(body)
      .replace(/\{name\}/g, person.name || '')
      .replace(/\{last\}/g, fmtMD(person.last))
      .replace(/\{elapsed\}/g, String(person.elapsed))
      .replace(/\{count\}/g, String(person.count))
      .replace(/\{clinic\}/g, c.name)
      .replace(/\{phone\}/g, c.phone)
      .replace(/\{url\}/g, location.origin + '/');
  }
  function openCompose(person, kind) {
    if (!person) return;
    cust.selected = person;
    const panel = $('compose-panel');
    const slot = document.querySelector(`.admin-section[data-section="${kind}"] .compose-slot`);
    if (slot && panel.parentElement !== slot) slot.appendChild(panel);
    panel.hidden = false;
    document.querySelectorAll('.churn-layout').forEach((l) => l.classList.toggle('has-compose', l.contains(panel)));
    $('compose-person').textContent = `${person.name} 様（カルテ ${person.code}）・最終来院 ${fmtMD(person.last)}・${person.elapsed}日経過・来院 ${person.count}回${person.next ? `・次回予約 ${fmtMD(person.next)}` : ''}`;
    const templates = getTemplates();
    if (!cust.templateId || !templates.some((t) => t.id === cust.templateId)) cust.templateId = kind === 'retention' && templates.some((t) => t.id === 'nextvisit') ? 'nextvisit' : templates[0].id;
    renderTemplateChips();
    applyTemplate();
    renderCustomerViews();
    if (window.innerWidth < 1000) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function closeCompose() { cust.selected = null; const p = $('compose-panel'); if (p) p.hidden = true; document.querySelectorAll('.churn-layout').forEach((l) => l.classList.remove('has-compose')); }
  function renderTemplateChips() {
    const wrap = $('compose-templates');
    wrap.innerHTML = getTemplates().map((t) => `<button type="button" data-tpl="${escapeHtml(t.id)}" class="${t.id === cust.templateId ? 'is-active' : ''}">${escapeHtml(t.name)}</button>`).join('');
    wrap.querySelectorAll('button[data-tpl]').forEach((b) => b.addEventListener('click', () => { cust.templateId = b.dataset.tpl; renderTemplateChips(); applyTemplate(); }));
  }
  function applyTemplate() {
    const t = getTemplates().find((x) => x.id === cust.templateId) || getTemplates()[0];
    if (cust.selected) $('compose-text').value = fillTemplate(t.body, cust.selected);
  }
  function renderTemplateEditor() {
    $('template-fields').innerHTML = getTemplates().map((t) => `<div class="template-field">
      <input type="text" value="${escapeHtml(t.name)}" data-tpl-name="${escapeHtml(t.id)}" placeholder="テンプレート名">
      <textarea rows="7" data-tpl-body="${escapeHtml(t.id)}">${escapeHtml(t.body)}</textarea>
    </div>`).join('');
  }

  function bindCustomerUi() {
    document.querySelectorAll('.clinic-tab').forEach((b) => b.addEventListener('click', () => { closeCompose(); loadCustomers(b.dataset.clinic); }));
    document.querySelectorAll('.cust-refresh').forEach((b) => b.addEventListener('click', () => loadCustomers(cust.clinic, { force: true })));
    document.querySelectorAll('.filter-group').forEach((g) => {
      g.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        g.querySelectorAll('button').forEach((x) => x.classList.toggle('is-active', x === b));
        cust.filters[g.dataset.filter] = b.dataset.value;
        closeCompose();
        renderCustomerViews();
      }));
    });
    $('compose-close').addEventListener('click', () => { closeCompose(); renderCustomerViews(); });
    $('compose-copy').addEventListener('click', async () => {
      const ok = await copyToClipboard($('compose-text').value);
      const info = $('compose-info');
      info.textContent = ok ? 'コピーしました。公式LINEやSMSに貼り付けてください。' : 'コピーできませんでした。文面を選択してコピーしてください。';
      info.hidden = false;
      setTimeout(() => { info.hidden = true; }, 2500);
    });
    $('compose-edit-toggle').addEventListener('click', () => {
      const ed = $('template-editor');
      ed.hidden = !ed.hidden;
      if (!ed.hidden) renderTemplateEditor();
    });
    $('template-save').addEventListener('click', async () => {
      const list = getTemplates().map((t) => ({
        id: t.id,
        name: (document.querySelector(`[data-tpl-name="${CSS.escape(t.id)}"]`) || {}).value || t.name,
        body: (document.querySelector(`[data-tpl-body="${CSS.escape(t.id)}"]`) || {}).value || t.body,
      }));
      try {
        const r = await apiFetch('/api/admin/settings', { method: 'PUT', body: { churnTemplates: list } });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || '保存に失敗');
        cust.templates = d.settings.churnTemplates;
        renderTemplateChips(); applyTemplate();
        const info = $('compose-info'); info.textContent = 'テンプレートを保存しました'; info.hidden = false;
        setTimeout(() => { info.hidden = true; }, 2000);
      } catch (e) { alert('保存できませんでした: ' + ((e && e.message) || e)); }
    });
    $('template-reset').addEventListener('click', async () => {
      if (!confirm('テンプレートを初期の文面に戻しますか？')) return;
      try {
        await apiFetch('/api/admin/settings', { method: 'PUT', body: { churnTemplates: DEFAULT_TEMPLATES } });
        cust.templates = null;
        renderTemplateEditor(); renderTemplateChips(); applyTemplate();
      } catch { /* ignore */ }
    });
  }

  function renderHomeChurn() {
    const box = $('home-churn');
    if (!box) return;
    box.innerHTML = ['192', '193'].map((c) => {
      const d = cust.data[c];
      if (!d || d.error) return `<div class="home-stat"><div class="home-stat-num"><b>–</b></div><small><b>${CLINICS[c].name}</b><br>未読み込み（リストを開くと読み込みます）</small></div>`;
      const saveF = { ...cust.filters };
      const saveC = cust.clinic;
      cust.clinic = c; cust.filters = { ...saveF, retNext: 'none', retMin: 0, churnRange: '60-90' };
      const ret = retentionRows(d).length;
      const ch = churnRows(d).length;
      cust.filters = saveF; cust.clinic = saveC;
      return `<div class="home-stat"><div class="home-stat-num"><b>${ret}</b><span>人</span></div><small><b>${CLINICS[c].name}</b> 次回予約なし（60日以内）<br>離反 60〜90日 <b>${ch}</b> 人・読み込み ${fmtBuiltAt(d.builtAt)}</small></div>`;
    }).join('');
  }

  // ホーム用: 保存済みがある院だけ取り込む（Threease は読みに行かない）
  async function loadCustomersCachedForHome() {
    await Promise.all(['192', '193'].map(async (c) => {
      if (cust.data[c]) return;
      try {
        const r = await apiFetch(`/api/admin/customers?clinic=${c}&cached=1`).then((x) => x.json());
        if (r && r.data) cust.data[c] = r.data;
      } catch { /* ignore */ }
    }));
    renderHomeChurn();
  }

  async function loadStats() {
    const panel = document.getElementById('stats-panel');
    if (!panel) return;
    try {
      const r = await apiFetch('/api/admin/stats?days=3');
      if (!r.ok) {
        panel.innerHTML = '<p class="admin-help">統計情報を取得できませんでした。</p>';
        return;
      }
      const data = await r.json();
      const stats = data.stats || {};
      window.__lastStats = stats;
      renderHome();
      const days = Object.keys(stats).sort().reverse();
      if (days.length === 0) {
        panel.innerHTML = '<p class="admin-help">まだ計測データがありません。</p>';
        return;
      }
      let html = '';
      for (const day of days) {
        const kinds = stats[day] || {};
        const c = kinds.courses || { total: 0, ok: 0, fail: 0, cacheHit: 0, stale: 0, avgMs: null, successRate: null, cacheHitRate: null };
        if (c.total === 0) continue;
        const rateColor = c.successRate == null ? 'good'
          : c.successRate >= 99 ? 'good' : c.successRate >= 95 ? 'warn' : 'bad';
        const live = (c.ok || 0) + (c.fail || 0);
        html += `<div class="stats-day">
          <div class="stats-day-head">${escapeHtml(day)}</div>
          <div class="stats-day-body">
            <div class="stats-item">
              <div class="stats-label">問い合わせ数</div>
              <div class="stats-value">${c.total.toLocaleString()}</div>
            </div>
            <div class="stats-item">
              <div class="stats-label">上流成功率 <small>(実呼び出し ${live.toLocaleString()}件)</small></div>
              <div class="stats-value stats-${rateColor}">${c.successRate != null ? c.successRate + '%' : '-'}</div>
            </div>
            <div class="stats-item">
              <div class="stats-label">キャッシュ率</div>
              <div class="stats-value">${c.cacheHitRate != null ? c.cacheHitRate + '%' : '-'}</div>
            </div>
            <div class="stats-item">
              <div class="stats-label">失敗</div>
              <div class="stats-value">${(c.fail || 0).toLocaleString()}</div>
            </div>
            <div class="stats-item">
              <div class="stats-label">平均応答 <small>(成功時)</small></div>
              <div class="stats-value">${c.avgMs != null ? c.avgMs + 'ms' : '-'}</div>
            </div>
          </div>
        </div>`;
      }
      panel.innerHTML = html || '<p class="admin-help">まだ計測データがありません。</p>';
    } catch (e) {
      panel.innerHTML = '<p class="admin-help">統計情報を取得できませんでした。</p>';
    }
  }

  let _promoFiltersBound = false;
  function bindPromoFilters() {
    if (_promoFiltersBound) return;
    _promoFiltersBound = true;
    document.querySelectorAll('.promo-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.promo-tab').forEach((b) => b.classList.toggle('is-active', b === btn));
        promoFilter.kind = btn.dataset.kind;
        rerenderFiltered();
      });
    });
    const search = document.getElementById('promo-search');
    if (search) {
      search.addEventListener('input', () => {
        promoFilter.q = search.value;
        rerenderFiltered();
      });
    }
    const clinicSel = document.getElementById('promo-clinic-filter');
    if (clinicSel) {
      clinicSel.addEventListener('change', () => {
        promoFilter.clinic = clinicSel.value;
        rerenderFiltered();
      });
    }
  }
  function rerenderFiltered() {
    if (window.__lastPromoItems) renderPromos(window.__lastPromoItems);
  }

  function showLoginView() {
    $('login-card').hidden = false;
    $('auth-view').hidden = true;
    sessionStorage.removeItem(STORAGE_KEY);
  }

  function getPass() {
    return sessionStorage.getItem(STORAGE_KEY) || '';
  }

  async function apiFetch(path, opts = {}) {
    const headers = Object.assign(
      { 'Accept': 'application/json' },
      opts.headers || {},
      { 'X-Admin-Password': getPass() }
    );
    if (opts.body && typeof opts.body !== 'string') {
      opts.body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }
    const r = await fetch(path, Object.assign({}, opts, { headers }));
    if (r.status === 401) {
      showLoginView();
      $('login-error').textContent = 'セッション切れです。再ログインしてください。';
      $('login-error').hidden = false;
      throw new Error('unauthorized');
    }
    return r;
  }

  // --- Course list (for target dropdown) ---

  const courseCache = {}; // key = clinic + ':' + forNew(true/false) -> courses[]

  async function getCourses(clinic, forNew) {
    const key = `${clinic}:${forNew}`;
    if (courseCache[key]) return courseCache[key];
    try {
      const r = await fetch(`/api/courses?clinic=${clinic}&for_new=${forNew}`, {
        headers: { 'Accept': 'application/json' },
      });
      if (!r.ok) return [];
      const d = await r.json();
      courseCache[key] = d.courses || [];
      return courseCache[key];
    } catch { return []; }
  }

  async function refreshTargetCourseOptions(preserveValue) {
    const sel = $('f-targetCourseId');
    const help = $('f-target-help');
    const clinic = $('f-forClinic').value;
    const ft = $('f-forFirstTime').value;
    const kind = getKind();
    if (clinic === 'both' || ft === 'both') {
      sel.innerHTML = '<option value="">— 対象既存メニューは指定しません —</option>';
      sel.disabled = true;
      if (kind === 'shortcut' && clinic !== 'both' && ft === 'both') {
        // 院だけ pre-select したいケース：対象コース未指定でOK
        help.innerHTML = 'このまま保存すると、URLを開いたユーザーは <strong>院だけ自動選択された状態</strong> でスタートします（来院・コース・日時はユーザーが選択）。';
      } else {
        help.textContent = '対象既存メニューを指定する場合は、対象院と対象来院を1つずつ選んでください。';
      }
      return;
    }
    sel.disabled = false;
    help.textContent = '読み込み中…';
    // 3ヶ月モードと2回目以降モードはどちらも threease 側では for_new=false
    const forNew = ft === 'true';
    let courses = await getCourses(clinic, forNew);
    // 3ヶ月モードは【久しぶり】コースだけ、2回目以降モードは【久しぶり】以外だけに絞る
    if (ft === 'three_months') {
      courses = courses.filter((c) => /^【久しぶり】/.test(c.name));
    } else if (ft === 'false') {
      courses = courses.filter((c) => !/^【久しぶり】/.test(c.name));
    }
    let html = '<option value="">— 選択してください —</option>';
    for (const c of courses) {
      const meta = [];
      if (c.duration) meta.push(`${c.duration}分`);
      if (typeof c.price === 'number') meta.push('¥' + Number(c.price).toLocaleString('ja-JP'));
      const label = `${c.name}${meta.length ? ' (' + meta.join('・') + ')' : ''}`;
      html += `<option value="${c.id}">${escapeHtml(label)}</option>`;
    }
    sel.innerHTML = html;
    if (preserveValue != null) sel.value = String(preserveValue);
    help.textContent = courses.length ? `${courses.length}件のコースがあります。` : 'コースが取得できませんでした。';
  }

  function getKind() {
    return document.querySelector('input[name="kind"]:checked')?.value || 'override';
  }
  function detectKind(p) {
    const hasTarget = typeof p.targetCourseId === 'number';
    const hasOverrideValues = (typeof p.price === 'number')
      || (typeof p.name === 'string' && p.name.trim() !== '')
      || (typeof p.description === 'string' && p.description.trim() !== '');
    if (hasTarget) {
      return hasOverrideValues ? 'override' : 'shortcut';
    }
    // 対象既存メニュー未指定:
    //   表示内容なし & autoOpen ON → 院だけ自動入力（shortcut の派生）
    //   表示内容あり → 新メニュー追加
    if (!hasOverrideValues && p.autoOpen) return 'shortcut';
    return 'addon';
  }
  function setKind(kind) {
    const r = document.querySelector(`input[name="kind"][value="${kind}"]`);
    if (r) r.checked = true;
    applyKindUI();
  }
  function applyKindUI() {
    const kind = getKind();
    const isOverride = kind === 'override';
    const isShortcut = kind === 'shortcut';
    const isAddon = kind === 'addon';

    // Target course is shown for override and shortcut
    $('f-target-wrap').hidden = isAddon;
    $('f-targetCourseId').required = false;

    // Pricing/name/description fields hidden in shortcut mode
    $('f-name-wrap').hidden = isShortcut;
    $('f-description-wrap').hidden = isShortcut;
    // Price: hidden in shortcut mode only
    $('f-price-wrap').hidden = isShortcut;
    $('f-shortcut-help').hidden = !isShortcut;

    // autoOpen: hidden in shortcut mode (forced true on submit)
    $('f-autoopen-wrap').hidden = isShortcut;

    // 「通常メニューも残す」は価格変更（override）のときだけ表示
    $('f-keeporiginal-wrap').hidden = !isOverride;

    // Name required only for addon
    $('f-name').required = isAddon;
    $('f-name-label').innerHTML = isOverride
      ? '表示名 <small>(任意・空欄なら元のコース名を使用)</small>'
      : 'メニュー名';
    const descLabel = document.getElementById('f-description-label');
    if (descLabel) {
      descLabel.innerHTML = isOverride
        ? '説明 <small>(任意・空欄なら元のコースの説明を使用)</small>'
        : '説明 <small>(任意)</small>';
    }
    applyAutoOpenLevelUI();
    // shortcut + 院のみ pre-select のヘルプ文を即時反映
    refreshTargetCourseOptions(Number($('f-targetCourseId').value) || null);
  }

  // 「自動で進める範囲」セレクトは autoOpen が ON のときだけ表示
  function applyAutoOpenLevelUI() {
    const wrap = $('f-autoopenlevel-wrap');
    if (!wrap) return;
    const isShortcut = getKind() === 'shortcut';
    wrap.hidden = isShortcut || !$('f-autoOpen').checked;
  }

  document.querySelectorAll('input[name="kind"]').forEach((r) => {
    r.addEventListener('change', applyKindUI);
  });
  $('f-autoOpen').addEventListener('change', applyAutoOpenLevelUI);
  $('f-forClinic').addEventListener('change', () => refreshTargetCourseOptions());
  $('f-forFirstTime').addEventListener('change', () => refreshTargetCourseOptions());
  $('f-code-rand').addEventListener('click', () => {
    $('f-code').value = generateRandomCode(6);
    $('f-code').focus();
  });

  // --- Login ---

  $('login-btn').addEventListener('click', async () => {
    const pass = $('login-pass').value;
    $('login-error').hidden = true;
    if (!pass) {
      $('login-error').textContent = 'パスワードを入力してください';
      $('login-error').hidden = false;
      return;
    }
    sessionStorage.setItem(STORAGE_KEY, pass);
    const btn = $('login-btn');
    const orig = btn.textContent;
    btn.textContent = '確認中…';
    btn.disabled = true;
    try {
      const r = await apiFetch('/api/admin/promos');
      if (r.ok) {
        showAuthView();
      } else {
        const data = await r.json().catch(() => ({}));
        const msg = data.error || `ログインに失敗しました (HTTP ${r.status})`;
        const detail = data.message ? `\n${data.message}` : '';
        $('login-error').textContent = msg + detail;
        $('login-error').hidden = false;
        sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch (e) {
      if (e && e.message !== 'unauthorized') {
        $('login-error').textContent = '通信に失敗しました: ' + ((e && e.message) || e);
        $('login-error').hidden = false;
      }
    } finally {
      btn.textContent = orig;
      btn.disabled = false;
    }
  });

  $('login-pass').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('login-btn').click();
  });

  $('logout-btn').addEventListener('click', () => {
    showLoginView();
    $('login-pass').value = '';
  });

  // --- Promo CRUD ---

  async function loadPromos() {
    // 一覧表示で対象コース名を解決するため、4 つの (clinic × for_new) を
    // バックグラウンドで事前ロードしておく。
    Promise.all([
      getCourses('192', true).catch(() => []),
      getCourses('192', false).catch(() => []),
      getCourses('193', true).catch(() => []),
      getCourses('193', false).catch(() => []),
    ]).then(() => {
      // 名前が後で解決できたらもう一度描画し直す
      if (window.__lastPromoItems) renderPromos(window.__lastPromoItems);
    });
    try {
      const r = await apiFetch('/api/admin/promos');
      if (!r.ok) {
        renderPromos([], 'コース取得に失敗');
        return;
      }
      const data = await r.json();
      renderPromos(data.items || []);
    } catch (e) {
      renderPromos([], (e && e.message) || 'エラー');
    }
  }

  function clinicLabel(forClinic) {
    if (forClinic === '192') return '三島院';
    if (forClinic === '193') return '裾野院';
    return '両院';
  }
  function visitLabel(forFt) {
    if (forFt === 'true') return '初回';
    if (forFt === 'false') return '2回目以降';
    if (forFt === 'three_months') return '3ヶ月ぶり';
    return '来院問わず';
  }
  function findCourseNameSync(targetCourseId, forClinic, forFt) {
    if (typeof targetCourseId !== 'number') return null;
    const clinics = forClinic === '192' || forClinic === '193' ? [forClinic] : ['192', '193'];
    // 3ヶ月モードと2回目以降モードはどちらも threease 側では for_new=false
    const fts = forFt === 'true' ? [true]
      : (forFt === 'false' || forFt === 'three_months') ? [false]
      : [true, false];
    for (const c of clinics) {
      for (const f of fts) {
        const cached = courseCache[`${c}:${f}`];
        if (cached) {
          const found = cached.find((co) => co.id === targetCourseId);
          if (found) return found.name;
        }
      }
    }
    return null;
  }
  function kindLabel(kind, p) {
    if (kind === 'override') return '価格上書き';
    if (kind === 'shortcut') {
      return (p && typeof p.targetCourseId === 'number') ? '空き状況へ直行' : '院だけ自動入力';
    }
    return '新メニュー';
  }
  function buildPromoTitle(p, kind, courseName) {
    const segments = [];
    segments.push(clinicLabel(p.forClinic));
    segments.push(visitLabel(p.forFirstTime));
    if (kind === 'addon') {
      const nm = p.name && p.name.trim() ? p.name.trim() : '(無題のキャンペーン)';
      return `${segments.join(' / ')} / ${nm}`;
    }
    if (kind === 'shortcut' && typeof p.targetCourseId !== 'number') {
      segments.push('院だけ自動入力');
      return segments.join(' / ');
    }
    if (courseName) segments.push(courseName);
    else if (typeof p.targetCourseId === 'number') segments.push(`コースID:${p.targetCourseId}`);
    else segments.push('対象未指定');
    return segments.join(' / ');
  }

  // ----- Filter state -----
  const promoFilter = { kind: 'all', clinic: 'all', q: '' };

  function applyPromoFilter(items) {
    const q = promoFilter.q.trim().toLowerCase();
    return items.filter((p) => {
      const kind = detectKind(p);
      if (promoFilter.kind !== 'all' && promoFilter.kind !== kind) return false;
      if (promoFilter.clinic !== 'all') {
        if (promoFilter.clinic === 'both' && p.forClinic !== 'both') return false;
        if (promoFilter.clinic === '192' && p.forClinic !== '192') return false;
        if (promoFilter.clinic === '193' && p.forClinic !== '193') return false;
      }
      if (q) {
        const courseName = findCourseNameSync(p.targetCourseId, p.forClinic, p.forFirstTime) || '';
        const haystack = [
          p.code,
          p.name,
          p.description,
          courseName,
          buildPromoTitle(p, kind, courseName),
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }

  function updateFilterCounts(items) {
    const counts = { all: items.length, override: 0, shortcut: 0, addon: 0 };
    for (const p of items) counts[detectKind(p)]++;
    document.querySelectorAll('[data-count]').forEach((el) => {
      el.textContent = String(counts[el.dataset.count] || 0);
    });
  }

  function renderPromos(items, errorMsg) {
    const list = $('promo-list');
    const filterBar = document.getElementById('promo-filters');
    const emptyMsg = document.getElementById('promo-filter-empty');
    if (errorMsg) {
      list.innerHTML = `<p class="admin-error">${escapeHtml(errorMsg)}</p>`;
      if (filterBar) filterBar.hidden = true;
      return;
    }
    if (!items.length) {
      list.innerHTML = '<p class="admin-help">登録されているキャンペーンはありません。</p>';
      if (filterBar) filterBar.hidden = true;
      window.__lastPromoItems = items;
    renderHome();
      return;
    }
    // 更新日時の新しい順に並べる
    items = items.slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    window.__lastPromoItems = items;
    renderHome();

    if (filterBar) filterBar.hidden = false;
    updateFilterCounts(items);
    const visible = applyPromoFilter(items);

    if (visible.length === 0) {
      list.innerHTML = '';
      if (emptyMsg) emptyMsg.hidden = false;
      return;
    }
    if (emptyMsg) emptyMsg.hidden = true;
    items = visible;

    let html = '';
    for (const p of items) {
      const kind = detectKind(p);
      const courseName = findCourseNameSync(p.targetCourseId, p.forClinic, p.forFirstTime);
      const title = buildPromoTitle(p, kind, courseName);
      const fullUrl = location.origin + '/?promo=' + encodeURIComponent(p.code);
      // LINE のカード型メッセージなどで ?promo= 部分が剥がされる経路
      // 用に、# 形式の URL も用意する（ハッシュは絶対に剥がされない）
      const lineUrl = location.origin + '/#promo=' + encodeURIComponent(p.code);
      const chips = [];
      if (p.autoOpen) chips.push(`<span class="tag tag-auto">⚡ 自動進行</span>`);
      if (p.useNewCustomerLine) chips.push(`<span class="tag">💬 初回は新規集客用LINEへ</span>`);
      if (p.customFieldLabel) {
        chips.push(`<span class="tag">📝 ${escapeHtml(p.customFieldLabel)}${p.customFieldRequired ? '(必須)' : ''}</span>`);
      }
      if (kind === 'override' && typeof p.price === 'number') {
        chips.push(`<span class="tag tag-price">¥${Number(p.price).toLocaleString('ja-JP')}</span>`);
      }
      if (kind === 'addon') {
        if (p.duration != null) chips.push(`<span class="tag">${p.duration}分</span>`);
        if (typeof p.price === 'number') chips.push(`<span class="tag tag-price">¥${Number(p.price).toLocaleString('ja-JP')}</span>`);
      }
      const descShort = p.description && p.description.trim()
        ? `<p class="promo-item-desc">${escapeHtml(p.description.trim())}</p>`
        : '';
      html += `<div class="promo-item promo-item--${kind}" data-code="${escapeHtml(p.code)}">
        <div class="promo-item-head">
          <span class="promo-kind-badge promo-kind-${kind}">${escapeHtml(kindLabel(kind, p))}</span>
          <h3 class="promo-item-title">${escapeHtml(title)}</h3>
        </div>
        ${descShort}
        ${chips.length ? `<div class="promo-item-tags">${chips.join('')}</div>` : ''}
        <div class="promo-item-url-row">
          <input type="text" readonly value="${escapeHtml(fullUrl)}" data-url-for="${escapeHtml(p.code)}">
          <button type="button" class="admin-btn-mini" data-act="copy" data-code="${escapeHtml(p.code)}">コピー</button>
          <button type="button" class="admin-btn-mini" data-act="open" data-code="${escapeHtml(p.code)}">開く</button>
        </div>
        <div class="promo-item-url-row promo-item-url-line">
          <span class="promo-item-url-label" title="LINE カードメッセージなど ? が剥がれる経路向け">LINE 用 (# 形式)</span>
          <input type="text" readonly value="${escapeHtml(lineUrl)}" data-url-line-for="${escapeHtml(p.code)}">
          <button type="button" class="admin-btn-mini" data-act="copy-line" data-code="${escapeHtml(p.code)}">コピー</button>
        </div>
        <div class="promo-item-footer">
          <span class="promo-item-code-mini">?promo=<strong>${escapeHtml(p.code)}</strong></span>
          <div class="promo-item-actions">
            <button type="button" class="admin-btn-mini" data-act="edit" data-code="${escapeHtml(p.code)}">編集</button>
            <button type="button" class="admin-btn-mini admin-btn-danger" data-act="del" data-code="${escapeHtml(p.code)}">削除</button>
          </div>
        </div>
      </div>`;
    }
    list.innerHTML = html;
    list.querySelectorAll('button[data-act]').forEach((b) => {
      b.addEventListener('click', () => onItemAction(b.dataset.act, b.dataset.code, items));
    });
    list.querySelectorAll('input[data-url-for]').forEach((i) => {
      i.addEventListener('focus', () => i.select());
    });
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }

  function generateRandomCode(len = 6) {
    // Lowercase letters + digits, excluding visually confusing chars (0/o/1/l/i)
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let out = '';
    const buf = new Uint32Array(len);
    crypto.getRandomValues(buf);
    for (let i = 0; i < len; i++) out += chars[buf[i] % chars.length];
    return out;
  }

  function onItemAction(act, code, items) {
    const fullUrl = location.origin + '/?promo=' + encodeURIComponent(code);
    const lineUrl = location.origin + '/#promo=' + encodeURIComponent(code);
    if (act === 'open') {
      window.open(fullUrl, '_blank', 'noopener');
      return;
    }
    if (act === 'copy') {
      const btn = document.querySelector(`.promo-item[data-code="${CSS.escape(code)}"] button[data-act="copy"]`);
      copyToClipboard(fullUrl).then((ok) => {
        if (btn) {
          const o = btn.textContent;
          btn.textContent = ok ? 'コピー済' : '失敗';
          setTimeout(() => { btn.textContent = o; }, 1200);
        }
      });
      return;
    }
    if (act === 'copy-line') {
      const btn = document.querySelector(`.promo-item[data-code="${CSS.escape(code)}"] button[data-act="copy-line"]`);
      copyToClipboard(lineUrl).then((ok) => {
        if (btn) {
          const o = btn.textContent;
          btn.textContent = ok ? 'コピー済' : '失敗';
          setTimeout(() => { btn.textContent = o; }, 1200);
        }
      });
      return;
    }
    if (act === 'edit') {
      const p = items.find((x) => x.code === code);
      if (!p) return;
      $('f-code').value = p.code;
      $('f-name').value = p.name || '';
      $('f-description').value = p.description || '';
      $('f-price').value = p.price ?? '';
      $('f-forClinic').value = p.forClinic || 'both';
      $('f-forFirstTime').value = p.forFirstTime || 'both';
      $('f-autoOpen').checked = !!p.autoOpen;
      $('f-autoOpenLevel').value = ['clinic', 'visit', 'course'].includes(p.autoOpenLevel) ? p.autoOpenLevel : 'course';
      $('f-keepOriginalMenu').checked = !!p.keepOriginalMenu;
      $('f-useNewCustomerLine').checked = !!p.useNewCustomerLine;
      $('f-cf-label').value = p.customFieldLabel || '';
      $('f-cf-required').checked = !!p.customFieldRequired;
      $('f-cf-placeholder').value = p.customFieldPlaceholder || '';
      setKind(detectKind(p));
      refreshTargetCourseOptions(p.targetCourseId || null);
      $('f-code').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (act === 'del') {
      if (!confirm(`「${code}」を削除しますか？`)) return;
      apiFetch('/api/admin/promos?code=' + encodeURIComponent(code), { method: 'DELETE' })
        .then((r) => r.json())
        .then((data) => renderPromos(data.items || []))
        .catch(() => alert('削除に失敗しました'));
    }
  }

  $('promo-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const kind = getKind();
    const targetRaw = $('f-targetCourseId').value;
    const nameTrim = $('f-name').value.trim();
    const wantsTarget = kind === 'override' || kind === 'shortcut';
    const targetCourseId = wantsTarget && targetRaw !== '' ? Number(targetRaw) : null;
    const cfLabel = $('f-cf-label').value.trim();
    const body = {
      code: $('f-code').value.trim(),
      name: kind === 'shortcut' ? '' : nameTrim,
      description: kind === 'shortcut' ? '' : $('f-description').value.trim(),
      duration: null,
      price: kind === 'shortcut' || $('f-price').value === '' ? null : Number($('f-price').value),
      forClinic: $('f-forClinic').value,
      forFirstTime: $('f-forFirstTime').value,
      targetCourseId,
      autoOpen: kind === 'shortcut' ? true : $('f-autoOpen').checked,
      autoOpenLevel: $('f-autoOpenLevel').value,
      keepOriginalMenu: kind === 'override' ? $('f-keepOriginalMenu').checked : false,
      useNewCustomerLine: $('f-useNewCustomerLine').checked,
      customFieldLabel: cfLabel,
      customFieldRequired: cfLabel ? $('f-cf-required').checked : false,
      customFieldPlaceholder: cfLabel ? $('f-cf-placeholder').value.trim() : '',
    };
    $('form-error').hidden = true;
    $('form-info').hidden = true;
    if (kind === 'override' && targetCourseId == null && !nameTrim) {
      $('form-error').textContent = '対象既存メニューを選ぶか、種別を「新メニュー追加」に切り替えてメニュー名を入力してください。';
      $('form-error').hidden = false;
      return;
    }
    try {
      const r = await apiFetch('/api/admin/promos', { method: 'POST', body });
      const data = await r.json();
      if (!r.ok) {
        $('form-error').textContent = data.error || '保存に失敗しました';
        $('form-error').hidden = false;
        return;
      }
      $('form-info').textContent = '保存しました';
      $('form-info').hidden = false;
      $('promo-form').reset();
      $('f-autoOpen').checked = false;
      setKind('override');
      refreshTargetCourseOptions();
      renderPromos(data.items || []);
      setTimeout(() => { $('form-info').hidden = true; }, 2000);
    } catch (e) {
      // unauthorized handler will redirect
    }
  });

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // --- Init: try to use stored password silently ---
  (async () => {
    if (getPass()) {
      try {
        const r = await apiFetch('/api/admin/promos');
        if (r.ok) showAuthView();
      } catch {}
    }
  })();
})();
