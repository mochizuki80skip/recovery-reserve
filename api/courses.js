const ALLOWED_CLINICS = new Set(['192', '193']);
const UPSTREAM_BASE = 'https://api.threease.com/api/v1/home/providers';

const UPSTREAM_HEADERS = {
  'Accept': 'application/json',
  'Origin': 'https://reservation.threease.com',
  'Referer': 'https://reservation.threease.com/',
  'User-Agent': 'Mozilla/5.0 (compatible; recovery-clinic-mirror/1.0)',
  'Accept-Language': 'ja',
};

export default async function handler(req, res) {
  const clinic = String(req.query.clinic || '');
  const forNew = String(req.query.for_new || 'false') === 'true';

  if (!ALLOWED_CLINICS.has(clinic)) {
    return res.status(400).json({ error: 'invalid clinic' });
  }

  const url = `${UPSTREAM_BASE}/${clinic}/courses?per=100&page=1&home=false&for_new_customers=${forNew}`;

  try {
    const r = await fetch(url, { headers: UPSTREAM_HEADERS });
    if (!r.ok) {
      return res.status(502).json({ error: 'upstream error', status: r.status });
    }
    const rawText = await r.text();
    let data;
    try { data = JSON.parse(rawText); } catch { data = null; }
    const courses = ((data && data.courses) || []).map((c) => {
      let name = c.product_name || c.name;
      const desc = c.description || '';
      // threease 上の "3ヶ月以上来院なし" 用コース判定：
      //   ・名前に「3ヶ月／3ヵ月／3か月」を含む（旧）
      //   ・あるいは説明文が「最終来院日から〜3ヶ月以上ご来院がない方〜」
      const isThreeMonth =
        /3\s*[ヶヵか]\s*月/.test(name)
        || /最終来院.*3\s*[ヶヵか]\s*月|3\s*[ヶヵか]\s*月\s*以上.*(?:来院|来店)/.test(desc);
      if (isThreeMonth) {
        // 所要時間で表示名を出し分け（60分=【久しぶり】コンビ／90分=【久しぶり】オールイン）
        if (Number(c.duration) === 90) {
          name = '【久しぶり】オールインワン施術';
        } else {
          name = '【久しぶり】コンビネーション施術';
        }
      }
      return {
        id: c.id,
        name,
        description: desc,
        duration: c.duration,
        price: c.price,
      };
    });

    const debug = req.query.debug === '1';
    const payload = { clinic, for_new: forNew, courses };
    if (debug) payload._raw = rawText;

    // Course list rarely changes -> cache for 24 hours at the edge.
    // Edge cache を控えめに（コース名のリネーム規則を変えても 1 分以内に反映）
    res.setHeader('Cache-Control', debug ? 'no-store' : 'public, max-age=60, s-maxage=60, stale-while-revalidate=600');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(502).json({
      error: 'fetch failed',
      message: (err && err.message) || String(err),
    });
  }
}
