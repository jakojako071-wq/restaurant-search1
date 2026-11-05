/* 道路管理者等のデータを正規化したHTTPS GeoJSONの配信先を指定。未設定なら安全判定しない。
   status: confirmed_flood または road_closed, source: https URL, observed_at: ISO8601。
   配信先はCORS許可が必要。公的な全国統一配信を意味しません。 */
window.FLOOD_VERIFIED_FEED_URL = '';
