# リカバリー鍼灸院 空き状況サイト（Threease Pro 連携版）

Threease Pro（管理画面）の**実予約とシフト**から、スタッフ別に「そのコースが取れる時間」を計算して
ウィザード式 UI で空き状況を表示し、気になる枠をタップして公式LINEへ誘導するサイト。

旧版（`reservation.threease.com` の公開APIを中継する方式）から、空き状況の取得方法を Threease Pro の
裏API（管理画面が使っている非公式API）に置き換えたもの。**フロント（index.html / app.js / style.css）は旧版のまま**。

## 予約フロー（画面）

1. **院選択**（タブ）長泉三島院 (192) / 裾野長泉院 (193)
2. **STEP 1: 来院パターン** 初回 / 2回目以降 / 3ヶ月以上来院なし
3. **STEP 2: コース選択** 公開API から取得した実コース一覧から選ぶ（`/api/courses`）
4. **STEP 3: 日時選択** 選んだコースが取れる時間のみカレンダーで表示（`/api/availability`）
5. **STEP 4: LINE で予約** 予約用テキストを自動生成 → コピー → 公式LINEへ遷移

## 構成

```
recovery-reserve/
├── index.html / app.js / style.css   ウィザード形式フロント（旧版のまま）
├── admin/                            管理画面（限定メニュー・通信ログ）
├── api/
│   ├── availability.js   空き状況（Threease Pro → スタッフ別に計算）
│   ├── recheck.js        「?」枠の再確認（キャッシュを使わず1枠だけ判定）
│   ├── courses.js        コース一覧（公開API中継・旧版のまま）
│   ├── promos.js / admin/*.js   限定メニュー（Upstash Redis）
│   ├── _threease.js      Threease Pro ログイン・API呼び出し（トークン使い回し）
│   ├── _pro.js           院の基本情報／シフト＋予約の取得とキャッシュ
│   ├── _slots.js         スタッフ別の空き計算（純粋関数）
│   ├── _store.js         Redis／メモリの共通キャッシュ
│   └── _cache-stats.js   通信ログ（管理画面の統計）
├── scripts/
│   ├── check-threease.mjs   接続確認（node scripts/check-threease.mjs）
│   └── verify-day.mjs       検算（node scripts/verify-day.mjs 192 2026-09-20 24281）
├── dev-server.mjs        ローカル確認用（npm run dev → http://localhost:4100）
├── .env.local            ログイン情報（git に含めない）
└── vercel.json
```

## 空き状況の計算（`api/_slots.js`）

リカバリーの予約は**スタッフに紐づく**（ミツカル接骨院のベッド別とは違う）。

- スタッフの稼働時間 = `shift_assignments`（開始・終了）から `leaves`（休憩）を除いたもの
- 施術スタッフ = `field_therapist` かつ在籍中（`employment_status=active`）
- コースを担当できるスタッフ = そのスタッフの `products` に コースの `product_id` が含まれる人
- 開始時刻 t に所要 N 分のコースが取れる = `[t, t+N)` を丸ごと稼働中で他の予約と重ならないスタッフが、
  **担当未定（staff_id なし）の予約の数より多く**いること
- 仮予約（temporary）も埋まり扱い、キャンセル済みは無視
- 同時に使うユニット（施術スペース）数が院のユニット数を超えないこと
- 表示は 30 分刻み。時間軸（`axisAvailable`）は「誰かが稼働している時刻」

コースID（公開APIの id）は Threease Pro の item id と同じなので、`items` から `product_id` と所要時間を引く。
対応表に無い ID（限定メニュー等）は `duration` パラメータの分数だけで計算する。

## データの流れとキャッシュ

```
ブラウザ
  ↓ /api/availability?clinic=192&start=YYYYMMDD&end=YYYYMMDD&course_id=24281&duration=30
Vercel Serverless
  ├── 院の基本情報（スタッフ・コース対応表・ユニット数）  … 1時間キャッシュ
  └── シフト＋予約（本日から7日ごとのブロック）             … 60秒キャッシュ
        期限切れでも前回分があれば即返して裏で取り直す（stale-while-revalidate）
        取得失敗時は前回分を返し、60秒は再試行しない
Threease Pro API（api.threease.com/api/v1/therapists）
```

保存するのは正規化した最小形（日付・スタッフID・開始/終了の分・状態）だけで、お客様の名前は保存しない。

## 環境変数

| 名前 | 内容 |
| --- | --- |
| `THREEASE_INSTITUTE_CODE` | Threease Pro の整骨院コード |
| `THREEASE_STAFF_CODE` | スタッフコード |
| `THREEASE_PASSWORD` | パスワード |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis（無ければメモリキャッシュ。本番では設定推奨） |
| `ADMIN_PASSWORD` | 管理画面のパスワード |

ローカルでは `.env.local` に書く（`dev-server.mjs` が読み込む）。Vercel では Settings → Environment Variables に設定。

## 管理画面（`/admin`）

ミツカルの「マルミ」と同じ構成。PC は左に固定メニュー（ホーム／キャンペーン／システム）、スマホは横スクロールのピル型タブ。
機能は従来どおり **キャンペーン管理**（限定メニュー・専用URL）と **通信ログ** で、**ホーム** にキャンペーンの件数・最近の更新・通信状況をまとめて表示する。

- `admin/index.html` 骨組み、`admin/admin-layout.css` レイアウト、`admin/admin.css` 部品、`admin/admin.js` 動作
- 開いていたメニューは `sessionStorage` に覚える（再読み込みしても同じページ）
- ローカル（Redis 未設定）ではキャンペーンを `.local-promos.json` に保存する

## ローカル動作確認

```bash
node scripts/check-threease.mjs   # 接続確認
npm run dev                       # http://localhost:4100
```

`.env.dev.local`（git に含めない）を置くと `.env.local` の値をローカルだけ上書きできる（例: `ADMIN_PASSWORD=localtest` で管理画面の動作確認）。

## デプロイ手順（Vercel）

1. GitHub にこのフォルダのリポジトリを作成して push
2. Vercel → Add New → Project → リポジトリをインポート（Framework Preset: Other、Root Directory は既定）
3. 環境変数を設定 → Deploy

## 運用上の注意

- 表示は最大 60 秒程度の遅れがある。予約直後に枠が消えていない瞬間がありえる。
- 実際の予約確定は LINE 受付時に最終確認する旨を画面下部に注記。
- Threease Pro の API は非公式のため、仕様変更時は `api/_threease.js` / `api/_pro.js` を要修正。
