# 深淵の刻印 サーバー(abyss-relay v4)

このサーバー1つで、次のことができます。
- **ブラウザで遊ぶ**: サーバーの住所(例: `https://abyss-relay.onrender.com`)を開くだけでゲームが始まります(`abyss-arpg.html` を一緒に置いたとき)
- **ログインとクラウドセーブ**: IDとパスワードでログインすると、セーブが自動でサーバーに保存されます。ファイルの保存は不要。ほかのパソコンやスマホでも続きから遊べます(1アカウントでキャラ3体まで)
- **マルチプレイ**: ワールド(最大32人)とパーティー(最大4人)、プレイヤーどうしのトレード、チャット。ワールドはリーグ(永続 / その月のシーズン)ごとに別です
- **開発者メニュー**: 下の `DEV_USERS` に書いたアカウントでログインすると、ゲームにチートの開発者メニューと Excel の読み込みが出ます

## ファイル
- `server.js` … サーバーのプログラム
- `package.json` … Render が読む設定
- `abyss-arpg.html` … ゲーム本体(これを置くと、住所を開くだけで遊べる)
- `README.md` … この説明

## 1. GitHub に置く(新しくするときも同じ)
リポジトリの画面で「Add file」→「Upload files」に、上の4つをドラッグ →「Commit changes」。
同じ名前のファイルは上書きされ、Render が数分で自動的に入れ替えます。

## 2. Render の設定(はじめの1回だけ)
「New +」→「Web Service」→ リポジトリを選ぶ → Language: Node / Build Command: `npm install` / Start Command: `npm start` / Instance Type: Free

## 3. セーブを消えないようにする(Upstash・無料)
Render の無料プランは、サーバーが入れ替わるとファイルが消えます。セーブを消えないようにするには、無料のデータベース Upstash をつなぎます。
1. https://upstash.com でアカウントを作る(GitHub か Google のアカウントでログインできます)
2. 「Redis」→「Create Database」。名前は `abyss-save` など。地域(Region)は Render と同じか近い場所(Render の Oregon なら US-West)。プランは Free
3. できたデータベースの画面の「REST API」のところにある `UPSTASH_REDIS_REST_URL` と `UPSTASH_REDIS_REST_TOKEN` の値をコピー
4. Render のサービスの画面 →「Environment」→「Add Environment Variable」で2つとも追加(Key に名前、Value にコピーした値)→「Save Changes」
5. 数分後、`https://(あなたのサーバー)/health` を開いて `"storage":"upstash"` と出ればOK(`"file"` のときは、まだつながっていません)

TOKEN はパスワードと同じです。人に見せたり、GitHub に書いたりしないでください。

## 4. 開発者のアカウントを決める
1. ゲームで、開発者として使うアカウントを登録しておく(☁ アカウント →「新しく登録」)
2. Render のサービスの画面 →「Environment」→「Add Environment Variable」
3. Key に `DEV_USERS`、Value にそのアカウントのID(2人以上ならカンマ区切り)→「Save Changes」
4. 数分後、`/health` に `"devUsers":1` と出ればOK。ゲームでログインし直すと、メニューに「🛠 開発者メニュー」と「📊 ゲームデータ(Excel)」が出ます

## 確かめ方
- `https://(あなたのサーバー)/health` … `{"ok":true, ... "version":4, "season":"2026-11", "storage":"upstash", "game":true}`
  - `game:true` … ゲーム本体が置いてある(住所を開くと遊べる)
  - `season` … いまのシーズン(毎月1日の0時に切り替わる)
- 無料プランは、15分だれも使わないと眠ります。次に開くとき、起きるまで最大1分ほどかかります

## 設定(Render の Environment)
- `MAX_PLAYERS` … ワールドの最大人数(初期値 32)
- `PARTY_MAX` … パーティーの最大人数(初期値 4)
- `DEV_USERS` … 開発者のアカウントのID(カンマ区切り)
- `SEASON_TZ` … シーズンが切り替わる時刻の時差(初期値 9 = 日本時間)。ゲームの Excel の基本設定 seasonTz と同じにする
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` … セーブの保存先
