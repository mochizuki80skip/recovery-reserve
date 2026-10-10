# recovery-reserve — AI（Claude Code）向け作業案内

リカバリー鍼灸院（2院: 192 長泉三島院 / 193 裾野長泉院）の「空き状況サイト＋管理画面」。
本番: https://recovery-reserve.vercel.app/ （管理画面は `/admin`）。GitHub `mochizuki80skip/recovery-reserve` main → push で自動デプロイ。
仕様の詳細は `README.md` にある。ここには「作業の進め方」と「触る時の注意」だけ書く。

## まず知っておくこと

- 依頼者は望月さん。日本語で、専門用語は避けて説明する。実装前に理解を短く言語化し、迷う点は確認してから進める（勝手に大きく作り変えない）。
- 素の HTML/CSS/JS（フレームワーク無し）＋ Vercel Serverless（`api/*.js`）。ビルド工程は無い。
- データ元は予約システム Threease の **非公式 API**（Pro 管理画面が使う `api.threease.com/api/v1/therapists`）。`api/_threease.js` が唯一の入口。
- 保存先は Upstash Redis（ミツカル接骨院の `mitukaru` DB を共用）。**キーは必ず `recovery:` で始める**（他サイトのキーと衝突させない）。
- Threease は遅い（予約 1 件あたり約 15ms、並列にしても速くならない）。読む回数を増やす変更は慎重に。回数は管理画面「通信ログ」で見える。

## 秘密情報の扱い

- `.env.local` に Threease のログイン情報・管理パスワード・Redis の鍵が入っている（git には入らない）。**値を読み上げたり、チャットに貼ったり、コミットしたりしない。** パスワードの入力は望月さんが行う。
- ローカルで管理画面を試す時は `.env.dev.local` に `ADMIN_PASSWORD=localtest` を書く（`.env.local` を上書きする。終わったら削除）。本番のパスワードは AI は知らなくてよい。
- `.local-*.json` はローカル専用の保存ファイル。git には入らない。

## ローカルで動かす

```bash
node scripts/check-threease.mjs   # Threease に接続できるか（院一覧・予約件数を表示）
npm run dev                       # http://localhost:4100 （dev-server.mjs が静的ファイルと api/ を配信）
```

- Claude Code のプレビューは `.claude/launch.json` の `recovery-reserve` 設定で起動する（Bash で直接サーバーを立てない）。
- `api/*.js` は 1 リクエストごとに読み直されるが、`_` 付きのモジュールは最初の読み込みが残るので、**`api/_*.js` を変えたらサーバーを再起動する**。
- 望月さんはプレビューの表のタブを自分で触ることがある。検証は **裏のタブ**（`tabs_create` で作る）で行い、表のタブを勝手に動かさない。
- 管理画面の検証: 裏タブで `/admin` を開く → パスワード欄に `localtest` → 各ページを開く。API を直接叩く時は `curl -H "x-admin-password: localtest" http://localhost:4100/api/admin/...`。
- ローカルは Redis が無いのでメモリ保存。お客様データは開くたびに Threease から読む（三島 15 秒・裾野 40 秒）。通信ログは出ない。

## 変更の流れ

1. 変更 → `node --check` で構文確認 → ローカルで動作確認（裏タブ）。
2. `git add -A && git commit` → `git push`（自動で本番へ）。コミット文は日本語で「何を・なぜ」。
3. 本番確認は裏タブで `https://recovery-reserve.vercel.app/...` を開いて `fetch` で確認する（curl は Vercel の Security Checkpoint で 403 になることがある）。管理画面 API は 401 が返れば「存在して保護されている」。
4. Vercel の「Redeploy」ボタンは古い版を戻すことがあるので使わない。再デプロイは空コミットの push で。

## 構成（どこを触るか）

| やりたいこと | 場所 |
| --- | --- |
| 空き状況の計算ルール（スタッフ別） | `api/_slots.js`（純粋関数 `computeDay`）、入口 `api/availability.js` |
| Threease からの取得・キャッシュ | `api/_pro.js`（院情報 1h、シフト＋予約は 7 日ブロック 60 秒）、`api/_threease.js` |
| お客様データ（毎朝の全件読み込み） | `api/_customers.js`、`api/admin/customers.js`、cron `api/cron-churn.js` |
| 管理画面の画面・動き | `admin/index.html`（骨組み・各セクション）、`admin/admin.js`（1 ファイルに全部）、`admin/admin-layout.css`（レイアウト）、`admin/admin.css`（部品） |
| 離反対策リスト／離反リスト／分析ページの計算 | `admin/admin.js` の `cust` まわり（`retentionRows` / `churnRows` / `renderStats` / `renderRates` / `renderSymptoms` / `renderMonthly`）。計算はすべて画面側 |
| 文面テンプレート・LIFF ID などの設定 | `api/admin/settings.js`（Redis `recovery:settings`） |
| 手動ブロック | `api/_busy.js`、`api/busy.js`、`admin/admin.js` の `blk` まわり |
| キャンペーン（限定メニュー・専用 URL） | `api/promos.js`、`api/admin/promos.js`、`api/_admin-helpers.js`、`admin/admin.js` の `renderPromos` |
| お客様向けページ | `index.html`、`app.js`、`style.css`（旧サイトのまま。変更は最小限に） |

管理画面の新しいページを足す時は: `admin/index.html` に `<section class="admin-section" data-section="名前">` とナビの `<button class="nav-item" data-section="名前">` を追加 → `admin/admin.js` の `SECTIONS` に見出しと説明を追加 → 必要なら `showSection` に読み込みの呼び出しを追加。

## 制約・落とし穴

- **Vercel Hobby は Serverless Function が 12 個まで**（`api/` 配下の `_` 無しファイル数）。今 11 個。増やす時は既存に相乗りさせる。cron は 2 本まで・1 日 1 回。
- 関数の実行時間は `vercel.json` の `maxDuration`（長い処理は 300 秒を設定済み）。
- 管理画面 API は全部 `x-admin-password` ヘッダーで認証（`api/_admin-helpers.js` の `checkAuth`）。お客様向け API（availability / courses / promos / recheck）は認証なし。
- Threease の担当スタッフ名「スタッフ」は退職者の汎用名。担当別の数字はその分を割り引いて読む。
- お客様の名前を Redis やログに不用意に残さない（お客様データの保存は最終来院 400 日以内の人だけ・必要最小限の項目）。
- 日付は JST で扱う（`api/_pro.js` の `todayJst` / `addDaysYmd`）。Vercel の関数は UTC で動く。
- `admin/admin.js` を node スクリプトで一括置換する時、シェルの引用で `\d` や `${}` が壊れやすい。Edit ツールか、差し替え内容を別ファイルに書いてから splice する。

## 望月さんとの約束・決まっていること

- 空き状況の UI は旧サイトのまま（変えない）。
- 離反対策リスト = 最終来院 60 日未満・次回予約なし（初期）、離反リスト = 60 日以上（期間フィルター）。離反率の分母は「120 日以内に担当した人」。
- 「新規継続率」「離反率・継続率」「症状別」「月次の数字」は分析グループ。
- LIFF（公式LINEの中で確実に開く URL）はサイト側の準備済み。LIFF ID の作成は望月さんが「いつか」行う。
- 旧サイト（mochizuki-bn3q.vercel.app）は当面残す。キャンペーン 24 件は新サイトへ取り込み済み。

困ったら `README.md` の該当節を読む。それでも分からない仕様は、推測で実装せず望月さんに聞く。
