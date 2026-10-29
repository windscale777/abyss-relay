# 深淵の刻印 マルチプレイ用サーバー(abyss-relay)

同じ「合言葉」の部屋に入った仲間(最大4人)のゲームどうしを、つなぐだけの小さなサーバーです。
ゲームの計算はしません(部屋を作った人のゲームが敵を動かします)。

## Render(無料)に置く方法

1. GitHub で新しいリポジトリを作る(名前の例: `abyss-relay`、Public でOK)
2. このフォルダの `package.json`・`server.js`・`README.md` の3つをアップロードする
   (リポジトリの画面の「Add file」→「Upload files」に3つをドラッグ →「Commit changes」)
3. Render にログイン →「New +」→「Web Service」→ GitHub をつないで、作ったリポジトリを選ぶ
4. 設定はこのとおり:
   - Language(Runtime): **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: **Free**
5. 「Deploy Web Service」を押して、数分待つ。上に出る住所(`https://○○○.onrender.com`)をコピー
6. ゲームの右の「👥 マルチ」→「サーバーの住所」にその住所を貼る

住所をブラウザで開いて `{"ok":true,...}` と出れば動いています。

## メモ
- 無料プランは、15分だれも使わないと眠ります。次に接続するとき起きるまで最大1分ほどかかります(ゲームが自動で待ちます)
- 人数の上限を変えたいときは、Render の「Environment」に `MAX_PLAYERS` を足します(例: 6)
