# いま営業中のお店

GitHub Pagesを画面の公開に使い、店舗情報・口コミ・写真はSupabaseに保存して端末間で共有します。

## GitHub Pagesで公開する

GitHub Pagesの設定で公開ブランチとフォルダーを選択します。公開ファイルには `index.html`、`style.css`、`script.js`、`supabase-config.js`、`manifest.webmanifest`、`app-icon.svg` を含めてください。

## Supabaseを設定する

### 既存環境に災害監視・デスクトップ通知を反映する場合

災害監視はSupabase Edge Functionが継続し、デスクトップ通知はアプリを開いているブラウザーで表示します。通知を受け取るには、HTTPSでアプリを開き、画面上部の「デスクトップ通知を有効にする」を押してブラウザーの許可を選んでください。アプリを閉じている間は通知されません。災害発生時に通知するには、担当店舗アカウントまたはサイト管理者でログインしておく必要があります。

コマンドは**WindowsのPowerShellターミナル**で実行し、SQLは**SupabaseのWeb画面にあるSQL Editor**で実行します。

#### 1. PowerShellを開いてプロジェクトに接続

VS Codeでこのアプリのフォルダーを開き、上部メニューの「ターミナル」→「新しいターミナル」を選びます。次を1行ずつ実行してください。

```powershell
cd "C:\Users\harus\OneDrive\Desktop\飲食店検索"
npx.cmd supabase login
```

ログイン時にブラウザーが開いたら、Supabaseにログインして許可します。続いてSupabaseのプロジェクトIDを指定します。プロジェクトIDはSupabaseのプロジェクト画面URL `https://supabase.com/dashboard/project/ここにあるID` から確認できます。

```powershell
npx.cmd supabase link --project-ref ここを自分のプロジェクトIDに置き換える
```

#### 2. 不要になったメール設定を削除

```powershell
npx.cmd supabase secrets unset RESEND_API_KEY DISASTER_EMAIL_FROM DISASTER_APP_URL
```

以前READMEや公開リポジトリにResend APIキーを記載した場合は、Resendのダッシュボードでそのキーを削除してください。キーは漏えいしたものとして扱い、再利用しないでください。前回の災害監視で登録した `DISASTER_SERVICE_ROLE_KEY` と `DISASTER_CRON_SECRET` は削除せず、そのまま使います。

#### 3. 災害監視プログラムを更新

同じPowerShellターミナルで次を実行します。

```powershell
npx.cmd supabase functions deploy refresh-disaster-status
```

#### 4. Supabaseのデータベース設定を更新

ブラウザーでSupabaseのプロジェクトを開き、「SQL Editor」→「New query」を選びます。[`supabase-schema.sql`](./supabase-schema.sql) の内容をすべて貼り付けて「Run」を押してください。既存の店舗データは維持されます。

#### 5. 店舗担当者と店舗を紐づけ

デスクトップ通知を受け取る店舗には、ログイン中の担当者アカウントが紐づいている必要があります。移行した店舗などで紐づけが未設定の場合は、「初回データ移行」にある `owner_id` の設定を行ってください。

以上で設定は完了です。災害監視は5分ごとに実行されます。通知の表示にはアプリを開いた状態とブラウザーでの通知許可が必要です。

#### 「restaurant_disaster_incidents が見つからない」と表示された場合

これは、アプリが接続しているSupabaseプロジェクトに災害監視用テーブルがまだ作成されていない場合に表示されます。

1. SupabaseのDashboardで、アプリが接続しているものと同じプロジェクトを開きます。プロジェクトURLは `supabase-config.js` の `url` と一致している必要があります。
2. 「SQL Editor」→「New query」を開き、[`supabase-schema.sql`](./supabase-schema.sql) の内容を最初から最後まで貼り付けて「Run」を押します。エラーが出た場合は、そのエラーを解消してから先に進みます。
3. 実行が成功したらアプリのページを再読み込みします。まだ同じエラーが出る場合は、SQL Editorで次を実行してスキーマ情報を更新し、もう一度ページを再読み込みします。

   ```sql
   notify pgrst, 'reload schema';
   ```

このテーブルが未設定でも通常の店舗・口コミデータは読み込めますが、災害時の状態表示と自動監視は、スキーマを反映するまで利用できません。

### 新規プロジェクトを作成する場合

1. Supabaseでプロジェクトを作成します。
2. Supabase CLIでプロジェクトをリンクし、自動災害監視 Edge Function にSupabaseのservice_role keyと十分に長いランダムなCron用秘密値を設定してデプロイします。

   ```powershell
   npx.cmd supabase link --project-ref YOUR-PROJECT-REF
   npx.cmd supabase secrets set DISASTER_SERVICE_ROLE_KEY="YOUR-SERVICE-ROLE-KEY" DISASTER_CRON_SECRET="YOUR-RANDOM-SECRET"
   npx.cmd supabase functions deploy refresh-disaster-status
   ```

   service_role keyなどの秘密情報はSupabaseのサーバー側Secretとしてのみ保存します。`supabase-config.js`、GitHub Pages、クライアント側コードには絶対に記入しないでください。
3. Supabase VaultにプロジェクトURLと同じcron秘密値を登録します（SQL Editorで実行）。秘密値はソースコードに保存しません。

   ```sql
   select vault.create_secret('https://YOUR-PROJECT.supabase.co', 'project_url');
   select vault.create_secret('YOUR-RANDOM-SECRET', 'disaster_cron_secret');
   ```

4. SupabaseのSQL Editorで [`supabase-schema.sql`](./supabase-schema.sql) 全体を実行します。店舗・口コミテーブル、RLS、写真用ストレージ、災害状態、Realtimeと5分ごとの監視スケジュールを設定します。Vaultに必要な2つの値がない場合は災害監視スケジュールを作成しないため、値を登録後にスキーマを再実行してください。
5. SupabaseのProject URLとpublishable/anon keyを [`supabase-config.js`](./supabase-config.js) に設定します。

   ```js
   window.SUPABASE_CONFIG = {
     url: 'https://YOUR-PROJECT.supabase.co',
     anonKey: 'YOUR-PUBLISHABLE-OR-ANON-KEY'
   };
   ```

   このファイルはブラウザーへ公開されます。publishable/anon keyだけを使い、`service_role` keyや秘密鍵は絶対に記入しないでください。データの保護はSupabaseのRow Level Securityポリシーで行います。

   すでにアプリを利用中の場合も、承認状態、店舗登録QR用のテーブルとRPC、災害監視・確認・営業再開用テーブルとRPC、権限ポリシー、臨時休業QR、自動削除スケジュールを更新するため、Edge FunctionとVaultの設定後に更新版 [`supabase-schema.sql`](./supabase-schema.sql) 全体をSQL Editorで再実行してください。メール通知用のデータベース項目も削除されます。既存店舗は公開状態を保ち、新しく作成される店舗は承認待ちになります。定期処理にはSupabaseの`pg_cron`と`pg_net`拡張機能を使用します。

6. Supabase AuthenticationでEmailプロバイダーを有効にし、公開サイトのURLをSite URLおよびRedirect URLsに登録します。メール確認を有効にする場合、担当者は確認メール内のリンクを開いてからログインします。
7. アプリからサイト管理者用のアカウントを作成し、そのメールアドレスでSupabaseにログインした後、SQL Editorで次を実行してモデレーター権限を付与します。

   ```sql
   update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
     || '{"role":"moderator"}'::jsonb
   where email = '管理者のメールアドレス';
   ```

   権限変更後はログアウトしてから再ログインしてください。`app_metadata`の変更はデータベース管理者だけが実行し、ユーザー編集可能な`user_metadata`には権限を保存しません。

## 初回データ移行

- 旧アプリを使っていた端末では、旧店舗データがブラウザーの `localStorage` に残っています。Supabase設定後、管理者アカウントでログインし、「この端末のデータを共有」を押すと、店舗・口コミ・写真を移行します。既に移行された店舗IDは上書きせず、途中で失敗したときは再実行で続きから移行します。
- この移行は同じブラウザー・同じ公開元URLに残っているデータが対象です。公開元URLが変わり旧データを読み込めない場合、アプリ上からの移行はできません。
- 旧店舗担当者のID・パスワードは移行しません。アプリは読み込み時に旧資格情報を端末内の移行データからも削除します。担当者は新しいメールアカウントを作成してください。
- 移行店舗は所有者未設定になります。担当者アカウントを作成した後、Supabase SQL Editorでその店舗の所有者を関連付けます（管理画面のAuthentication → UsersでユーザーUUIDを確認）。

   ```sql
   update public.restaurants
   set owner_id = '担当者のユーザーUUID'
   where id = '店舗ID';
   ```


## アカウントとデータ権限

- 誰でも承認済み店舗・口コミを閲覧でき、承認済み店舗へ口コミを投稿できます。承認待ちの店舗と口コミは一般利用者に公開されません。
- 店舗担当者はメールアドレスで登録・ログインすると、自分の店舗だけを操作できる店舗別管理画面が表示されます。店舗情報・画像の編集、臨時休業への切替と営業再開を行えます。通常の登録申請はモデレーターの承認後に公開され、1アカウントにつき1店舗です。
- Supabase Edge Functionが気象庁の防災JSON情報を5分ごとに取得します。店舗住所の都道府県と照合し、警報・特別警報、直近6時間の震度4以上の地震、発表中の津波警報・注意報がある場合は対象店舗を黄色の「災害発生のため不明」として表示し、営業中店舗から除外します。新しい災害情報を検知すると、アプリを開いているブラウザーで通知を許可した店舗担当者またはサイト管理者にデスクトップ通知を表示します。アプリを閉じている間は通知されません。災害情報が解除された後も不明の状態は維持されます。店舗担当者またはサイト管理者が対象店舗の「営業を再開」ボタンを押すと、その店舗の不明状態を解除して通常の営業状況に戻します。新しい災害情報が発表された場合は再度不明になります。
- ログイン中は「アカウント削除」からアカウントを削除できます。店舗がある場合は、店舗を所有者なしで残すか、店舗・口コミ・画像も削除するかを選べます。店舗削除時は災害確認情報も削除されます。アカウント削除RPCを使うため、更新後の [`supabase-schema.sql`](./supabase-schema.sql) をSQL Editorで実行してください。
- 「アカウント設定」ではログインメールアドレスとパスワードを変更できます。メール変更はSupabaseの認証設定により確認メールの操作が必要です。パスワード変更は8文字以上で、確認欄への再入力が必要です。
- サイト管理者の「店舗追加QR」は、モデレーターが発行する30日間有効・一度限りの登録用QRです。QRから登録した店舗はすぐに公開されます。QRを使わない通常申請は、モデレーター画面で承認された後に公開されます。
- モデレーターは管理画面の承認待ち一覧から申請を承認して公開するか、却下・削除できます。公開中の店舗の臨時休業への切替と営業再開も管理画面から行えます。
- 店舗運営者は自分の店舗ごとに臨時休業QRを発行できます。読み取ると確認操作なしで臨時休業になり、再発行すると以前のQRは無効になります。QRのURL自体が操作権限を持つため、掲示場所と配布先を管理してください。
- サイト管理者はSupabaseの`app_metadata.role = moderator`で識別され、店舗の登録・削除、口コミ削除、一括移行を行えます。
- 店舗画像はSupabase Storageの公開画像バケットにアップロードされます。画像は最大10枚で、登録時に縮小・圧縮し、1枚あたり5MB以下で保存します。
- 口コミは投稿から暦上1か月間だけ画面に表示されます。期限を過ぎた口コミデータはDBに残ります。
- 店舗情報が1か月間更新されない店舗は、毎日03:00 UTCの定期処理で削除されます。店舗削除に伴い口コミと臨時休業QR情報も削除されます。Storage内の店舗画像ファイルは自動削除されないため、必要に応じて別途整理してください。
- 災害情報の自動監視にはSupabase Edge Function、Vault、`pg_cron`、`pg_net`の設定が必要です。画面上の監視状態表示が15分以上更新されない場合は、SupabaseのCronジョブとEdge Functionログを確認してください。
- 公開ページに秘密鍵を含めないでください。テーブル・画像へのアクセス制御はSupabase SQLのRLSポリシーが適用されます。
- 口コミ投稿は公開で受け付けるため、一般公開後はスパム対策（CAPTCHAやレート制限）を追加することを推奨します。

## iPhoneで使う方法

GitHub PagesのHTTPS公開URLをSafariで開き、「共有」→「ホーム画面に追加」を選びます。

## 制約

- 地図・QRコードライブラリはCDNから読み込むため、インターネット接続が必要です。
- 地図をクリックした位置の住所取得にはOpenStreetMapのNominatimを利用するため、インターネット接続が必要です。
- 位置情報はHTTPSで公開したSafari上で許可してください。
- 店舗の営業時間は毎日の開店・閉店時刻で登録します。営業時間の判定には閲覧端末の時刻を使い、営業中を青い背景で上に、営業時間外・臨時休業中を赤い背景で下に表示します。
- 災害情報はSupabase Edge Functionが取得し、5分ごとのサーバー処理で判定します。災害判定は店舗ごとに保存され、気象庁情報が解除された後も「営業を再開」ボタンを押すまで確認中のままです。対象地域は住所に含まれる都道府県名で照合するため、都道府県を判定できない住所は対象になりません。監視失敗は画面の監視状態に表示されます。災害時は画面だけに頼らず、気象庁・自治体の最新情報を確認してください。
- 店舗情報の保存と臨時休業状態の変更を店舗更新として記録します。口コミの投稿だけでは店舗の更新日時は変わりません。
- 店舗データはSupabaseに保存され、同じプロジェクトに接続するブラウザー間で共有されます。ブラウザー画面の更新にはRealtimeを使います。
- Supabaseプロジェクトで定期バックアップを設定してください。
- 店舗ごとに写真を最大10枚登録できます。画像は保存容量を抑えるため縮小・圧縮し、1枚あたり5MB以下で保存して店舗詳細に一覧表示します。既存の店舗情報編集画面から写真の追加・削除もできます。
- 口コミと評価はSupabaseに保存され、どの端末からも参照できます。モデレーターとしてログインすると、店舗詳細から口コミを削除できます。
- Supabase設定を済ませるまでは、共有データベースは利用できません。画面に表示される接続状態を確認してください。

## ファイル

- `index.html`: 画面とiOSホーム画面設定
- `style.css`: UIスタイル
- `script.js`: アプリ処理
- `supabase-config.js`: Supabaseの公開URLとpublishable/anon key
- `supabase-schema.sql`: データベース、RLS、写真ストレージ、Realtime設定
- `supabase/config.toml`: Supabase CLIのEdge Function設定
- `supabase/functions/refresh-disaster-status/index.ts`: 気象庁情報を取得するサーバー側の定期監視処理
- `manifest.webmanifest`: ホーム画面起動用のWebアプリ設定
- `app-icon.svg`: アプリアイコン


## 地域別災害訓練
更新版supabase-schema.sqlをSQL Editorで実行してから公開してください。管理者の災害情報テストから全国・都道府県・市区町村と災害種別を指定できます。訓練は公開画面に明示され、実際の災害情報と店舗営業状態は変更しません。住所文字列で地域を照合するため住所表記に依存します。通知はブラウザが開いている担当者・管理者向けで、更新確認は最大約1分間隔です。
