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
    loadPromos();
    loadStats();
  }

  // サイドバーのナビ: 「キャンペーン管理」「通信ログ」をクリックで切替（PC向け）。
  // モバイルでは CSS で常に全セクション表示にしているのでナビは飾り扱い。
  let _adminNavBound = false;
  function bindAdminNav() {
    if (_adminNavBound) return;
    _adminNavBound = true;
    document.querySelectorAll('.admin-nav-item[data-section]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.section;
        document.querySelectorAll('.admin-section').forEach((s) => {
          s.hidden = s.dataset.section !== target;
        });
        document.querySelectorAll('.admin-nav-item[data-section]').forEach((b) => {
          b.classList.toggle('is-active', b === btn);
        });
      });
    });
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
      return;
    }
    // 更新日時の新しい順に並べる
    items = items.slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    window.__lastPromoItems = items;

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
